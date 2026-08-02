import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
// codemogger is ESM-only with an `exports` map lacking a `require`/`default`
// condition, so it must be loaded via dynamic `import()` (resolves the ESM
// condition even from a CJS caller — e.g. Next's server bundle / the test loader).
// Types are import-type only (erased at compile time; no runtime resolution).
import type { CodeIndex, SearchResult } from 'codemogger';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { log } from './logger';

/**
 * IN-PROCESS codemogger code-search engine (docs/ticket-local-mcp-this-project-
 * fails-first-use.md → decision #2, macОS DB contention).
 *
 * The old design ran codemogger as a stdio MCP server (spawned by the Claude CLI for
 * SEARCH) AND had Fury spawn a separate `codemogger index` process for REINDEX. Two
 * OS processes over one SQLite/Turso file — and every reindex does `DROP/CREATE` DDL
 * on the FTS index — which on macOS's file-locking corrupts / deadlocks.
 *
 * This hosts codemogger IN Fury's process via the SDK's `createSdkMcpServer`, using
 * codemogger's `CodeIndex` LIBRARY. Search (model → SDK in-process tool) and reindex
 * (Fury's watcher) then share ONE `CodeIndex` (one persistent DB connection), and a
 * per-project async mutex serializes them so a reindex's DDL never overlaps a search.
 * One process, one writer — the contention is gone by construction.
 *
 * Model: `all-MiniLM-L6-v2` (q8), the same 384-dim model codemogger's default uses,
 * so indexes are compatible. The embedder is loaded once, lazily, and shared.
 */

const EMBEDDING_MODEL = 'all-MiniLM-L6-v2';

// ── codemogger CodeIndex ctor (dynamic ESM import, loaded once) ─────────────────
type Embedder = (texts: string[]) => Promise<number[][]>;
type CodeIndexCtor = new (opts: { dbPath: string; embedder: Embedder; embeddingModel: string }) => CodeIndex;
let ctorPromise: Promise<CodeIndexCtor> | null = null;
function loadCodeIndexCtor(): Promise<CodeIndexCtor> {
  if (!ctorPromise) {
    ctorPromise = import('codemogger')
      .then(m => m.CodeIndex as unknown as CodeIndexCtor)
      .catch((err) => { ctorPromise = null; throw err; });
  }
  return ctorPromise;
}

// ── Embedder (shared singleton, lazy) ──────────────────────────────────────────
let embedderPromise: Promise<Embedder> | null = null;
function getEmbedder(): Promise<Embedder> {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async () => {
    // Imported lazily so the model + onnxruntime only load when code search is used.
    const { pipeline } = await import('@huggingface/transformers');
    const pipe = await pipeline('feature-extraction', `Xenova/${EMBEDDING_MODEL}`, { dtype: 'q8' });
    return async (texts: string[]): Promise<number[][]> => {
      const out = await pipe(texts, { pooling: 'mean', normalize: true });
      return out.tolist() as number[][];
    };
  })().catch((err) => {
    embedderPromise = null; // allow a later retry
    throw err;
  });
  return embedderPromise;
}

// ── Per-project registry (one CodeIndex each) ───────────────────────────────────
interface Entry {
  codeIndex: CodeIndex;
}
// registry holds a PROMISE per project so creation is single-flight — two concurrent
// callers must not build two CodeIndex instances (two DB connections) for one project.
const registry = new Map<string, Promise<Entry>>();
// Per-project op chain, separate from creation, so search never overlaps a reindex.
const locks = new Map<string, Promise<unknown>>();
const norm = (p: string) => p.replace(/\\/g, '/');

/** Serialize an op behind the project's current op (search never overlaps reindex). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => {}, () => {})); // tail never rejects
  return run;
}

/** Format search hits the way codemogger's own MCP does (path:lines [kind] name). */
function formatResults(results: SearchResult[], includeSnippet: boolean): string {
  if (!results.length) return 'No results.';
  return results.map((r, i) => {
    const head = `${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}  [${r.kind}] ${r.name}`;
    const sig = r.signature ? `\n   ${r.signature}` : '';
    const snip = includeSnippet && r.snippet ? `\n\`\`\`\n${r.snippet}\n\`\`\`` : '';
    return head + sig + snip;
  }).join('\n\n');
}

/**
 * Build the in-process SDK MCP server exposing codemogger's tools for a project.
 *
 * Built synchronously and cheaply — the heavy engine (`CodeIndex` + embedder) is
 * NOT created here. Each tool handler lazily resolves it via `getOrCreate(key,
 * dbPath)` on first invocation, so a session that never searches never pays the
 * embedder-load cost, and attaching this server at query-open time stays sync.
 */
function buildServer(key: string, dbPath: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'codemogger',
    version: '0.1.0',
    // Preload these 3 tool schemas instead of deferring them behind ToolSearch: code
    // search is only useful if the model reaches for it PROACTIVELY (the CLAUDE.md
    // template says to prefer codemogger_search over Grep/Glob), and a deferral hop
    // works against that. Scoped to codemogger — other MCP servers stay deferred. The
    // cost is 3 small tool definitions in context per turn (negligible).
    alwaysLoad: true,
    tools: [
      tool(
        'codemogger_search',
        'Semantic + keyword code search over this project\'s index. Prefer semantic mode for concepts and long/snake_case names; keyword for short identifiers.',
        {
          query: z.string(),
          mode: z.enum(['semantic', 'keyword']).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          includeSnippet: z.boolean().optional(),
        },
        async (args) => {
          const includeSnippet = args.includeSnippet ?? true;
          const { codeIndex } = await getOrCreate(key, dbPath);
          const results = await withLock(key, () =>
            codeIndex.search(args.query, { mode: args.mode ?? 'semantic', limit: args.limit ?? 10, includeSnippet }));
          return { content: [{ type: 'text', text: formatResults(results, includeSnippet) }] };
        },
      ),
      tool(
        'codemogger_index',
        'Index (or re-index) a directory of this project into the code-search index.',
        { directory: z.string() },
        async (args) => {
          const { codeIndex } = await getOrCreate(key, dbPath);
          const r = await withLock(key, () => codeIndex.index(args.directory));
          return { content: [{ type: 'text', text: `Indexed ${r.files} files → ${r.chunks} chunks (embedded ${r.embedded}, skipped ${r.skipped}, removed ${r.removed}).` }] };
        },
      ),
      tool(
        'codemogger_reindex',
        'Re-index a directory (incremental; unchanged files are skipped). Fury also auto-reindexes on file changes.',
        { directory: z.string() },
        async (args) => {
          const { codeIndex } = await getOrCreate(key, dbPath);
          const r = await withLock(key, () => codeIndex.index(args.directory));
          return { content: [{ type: 'text', text: `Reindexed ${r.files} files → ${r.chunks} chunks (embedded ${r.embedded}, skipped ${r.skipped}, removed ${r.removed}).` }] };
        },
      ),
    ],
  });
}

/** Get (or lazily create, single-flight) the per-project engine for a DB path. */
function getOrCreate(key: string, dbPath: string): Promise<Entry> {
  let p = registry.get(key);
  if (!p) {
    p = (async () => {
      mkdirSync(dirname(dbPath), { recursive: true }); // CodeIndex won't mkdir an explicit db parent
      const [Ctor, embedder] = await Promise.all([loadCodeIndexCtor(), getEmbedder()]);
      const codeIndex = new Ctor({ dbPath, embedder, embeddingModel: EMBEDDING_MODEL });
      return { codeIndex };
    })().catch((err) => { registry.delete(key); throw err; }); // allow retry after a failed load
    registry.set(key, p);
  }
  return p;
}

/**
 * The in-process codemogger SDK MCP server for a project, to pass to the SDK's
 * `options.mcpServers`. SYNCHRONOUS and cheap — it does NOT load the engine or the
 * embedder; the tool handlers do that lazily on first search.
 *
 * A FRESH server instance is built PER CALL (per SDK session), NOT cached/shared: an
 * in-process `createSdkMcpServer` instance backs a single client connection, and a
 * prior session's teardown disposes it — so sharing one instance across concurrent
 * sessions makes the second session's codemogger "fail to connect" (observed:
 * warmup + find-turn on one project → find-turn's server failed). Every instance's
 * tool handlers route to the ONE shared `CodeIndex` via `getOrCreate`, so there's
 * still a single DB writer no matter how many session frontends exist.
 */
export function codemoggerSdkServer(projectPath: string, dbPath: string): McpSdkServerConfigWithInstance {
  return buildServer(norm(projectPath), dbPath);
}

/**
 * Reindex the given directories into the project's in-process index — mutex-
 * serialized with search, so the FTS DDL never fights a concurrent query. Called by
 * the watcher (after writes settle) and at registration for the initial index.
 */
export async function reindexProject(projectPath: string, dbPath: string, dirs: string[]): Promise<void> {
  const key = norm(projectPath);
  const { codeIndex } = await getOrCreate(key, dbPath);
  for (const dir of dirs) {
    try {
      const r = await withLock(key, () => codeIndex.index(dir));
      log.info('codemogger.reindex', 'indexed', {
        data: { dir, summary: `Indexed ${r.files} files → ${r.chunks} chunks, skipped ${r.skipped}, removed ${r.removed}` },
      });
    } catch (err) {
      log.warn('codemogger.reindex', 'index failed', {
        data: { dir, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/**
 * Search the project's in-process index (mutex-serialized with reindex). Mirrors the
 * `codemogger_search` tool — exposed for parity/tests; the model reaches search via
 * the SDK tool.
 */
export async function searchProject(
  projectPath: string, dbPath: string, query: string,
  opts: { mode?: 'semantic' | 'keyword'; limit?: number; includeSnippet?: boolean } = {},
): Promise<SearchResult[]> {
  const key = norm(projectPath);
  const { codeIndex } = await getOrCreate(key, dbPath);
  return withLock(key, () => codeIndex.search(query, {
    mode: opts.mode ?? 'semantic', limit: opts.limit ?? 10, includeSnippet: opts.includeSnippet ?? true,
  }));
}

/** Drop a project's engine and CLOSE its DB connection (e.g. when code search is
 *  disabled, or in test teardown). Best-effort. */
export async function dropProject(projectPath: string): Promise<void> {
  const key = norm(projectPath);
  const p = registry.get(key);
  registry.delete(key);
  locks.delete(key);
  if (p) { try { (await p).codeIndex.close(); } catch { /* already closed / never opened */ } }
}
