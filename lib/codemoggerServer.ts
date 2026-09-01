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
import { CODESEARCH_MCP_SERVER_NAME } from './mcpRuntimeStatus';

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
// Per-project usage for idle eviction: last-op time + in-flight op count. Eviction
// only closes a CodeIndex when inFlight === 0, so a close can never race a live op.
interface Usage { lastUsed: number; inFlight: number }
const usage = new Map<string, Usage>();
// Bumped on EVERY dropProject, whether or not it can close the connection right then.
// reindexProject captures the value at start; a mismatch means "code search was
// disabled for this project — stop". It is checked twice: between directories (a cheap
// fast path) and again inside withEngine under the per-project lock (authoritative).
// Without it, a DELETE/disable landing mid-reindex would keep indexing into the
// now-disabled project, and could re-open a CodeIndex against its orphaned DB.
const generations = new Map<string, number>();
const norm = (p: string) => p.replace(/\\/g, '/');

/** Serialize an op behind the project's current op (search never overlaps reindex). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => {}, () => {})); // tail never rejects
  return run;
}

/** Thrown when a project was dropped while an op waited for its lock. Not a failure —
 *  reindexProject catches it to end the loop quietly. */
export class ProjectDroppedError extends Error {
  constructor(key: string) {
    super(`code search was disabled for ${key} while the operation was queued`);
    this.name = 'ProjectDroppedError';
  }
}

/**
 * Acquire the project's engine AND run `fn` under one lock hold — the SINGLE access
 * point for the CodeIndex. getOrCreate happens INSIDE the lock, and inFlight is bumped
 * synchronously at call time, so the entire acquire+use is counted in-flight. That's
 * what makes idle eviction safe: it only closes a connection when inFlight === 0, so
 * it can never close a CodeIndex a handler is mid-way through using. If a project was
 * evicted between calls, getOrCreate simply re-opens it here.
 *
 * `expectGeneration` makes the drop check AUTHORITATIVE: it is re-tested here, under
 * the lock, immediately before getOrCreate. reindexProject also checks between
 * directories, but that check is only safe because nothing awaits between it and this
 * call — an invariant a future refactor could quietly break, after which a drop that
 * interleaved would re-open a CodeIndex into the just-disabled project's DB. Checking
 * under the lock does not depend on that invariant.
 */
function withEngine<T>(
  key: string,
  dbPath: string,
  fn: (ci: CodeIndex) => Promise<T>,
  expectGeneration?: number,
): Promise<T> {
  let u = usage.get(key);
  if (!u) { u = { lastUsed: Date.now(), inFlight: 0 }; usage.set(key, u); }
  u.inFlight++; u.lastUsed = Date.now();
  const done = () => { u!.inFlight--; u!.lastUsed = Date.now(); };
  return withLock(key, async () => {
    if (expectGeneration !== undefined && (generations.get(key) ?? 0) !== expectGeneration) {
      throw new ProjectDroppedError(key);
    }
    const { codeIndex } = await getOrCreate(key, dbPath);
    return fn(codeIndex);
  }).then(
    (v) => { done(); return v; },
    (e) => { done(); throw e; },
  );
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
    // The runtime identity: this is the name the SDK reports connect failures
    // under, and what the MCP panel's code-search row matches against (P16).
    name: CODESEARCH_MCP_SERVER_NAME,
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
          const results = await withEngine(key, dbPath, ci =>
            ci.search(args.query, { mode: args.mode ?? 'semantic', limit: args.limit ?? 10, includeSnippet }));
          return { content: [{ type: 'text', text: formatResults(results, includeSnippet) }] };
        },
      ),
      tool(
        'codemogger_index',
        'Index (or re-index) a directory of this project into the code-search index.',
        { directory: z.string() },
        async (args) => {
          const r = await withEngine(key, dbPath, ci => ci.index(args.directory));
          return { content: [{ type: 'text', text: `Indexed ${r.files} files → ${r.chunks} chunks (embedded ${r.embedded}, skipped ${r.skipped}, removed ${r.removed}).` }] };
        },
      ),
      tool(
        'codemogger_reindex',
        'Re-index a directory (incremental; unchanged files are skipped). Fury also auto-reindexes on file changes.',
        { directory: z.string() },
        async (args) => {
          const r = await withEngine(key, dbPath, ci => ci.index(args.directory));
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
  const startGen = generations.get(key) ?? 0;
  for (const dir of dirs) {
    // Bail if the project was dropped (code search disabled) between directories —
    // else the withEngine below would re-open a CodeIndex for a now-disabled project
    // and index into its orphaned DB, leaving a handle until idle eviction.
    // Fast path: skip even enqueueing onto the lock chain. withEngine re-tests the
    // same generation under the lock, which is the authoritative check.
    if ((generations.get(key) ?? 0) !== startGen) {
      log.info('codemogger.reindex', 'aborted: project dropped mid-reindex', { data: { key } });
      break;
    }
    try {
      const r = await withEngine(key, dbPath, ci => ci.index(dir), startGen);
      log.info('codemogger.reindex', 'indexed', {
        data: { dir, summary: `Indexed ${r.files} files → ${r.chunks} chunks, skipped ${r.skipped}, removed ${r.removed}` },
      });
    } catch (err) {
      // A drop that landed while this dir waited for the lock — end the loop, don't
      // log it as an index failure.
      if (err instanceof ProjectDroppedError) {
        log.info('codemogger.reindex', 'aborted: project dropped while queued', { data: { key, dir } });
        break;
      }
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
  return withEngine(key, dbPath, ci => ci.search(query, {
    mode: opts.mode ?? 'semantic', limit: opts.limit ?? 10, includeSnippet: opts.includeSnippet ?? true,
  }));
}

/** Drop a project's engine and CLOSE its DB connection (e.g. when code search is
 *  disabled, or in test teardown). Best-effort.
 *
 *  Routed through the SAME per-project lock as search/reindex (P4). The previous
 *  version synchronously deleted registry/locks/usage and closed the connection with
 *  NO inFlight check and OUTSIDE the lock — so disabling code search mid-search (or
 *  mid-reindex DDL) closed the DB out from under the running op AND reset the lock
 *  chain, letting the next op start un-serialized behind the still-running one. Now
 *  it mirrors evictIdle's discipline: the close runs as an op in the chain (so all
 *  prior ops have finished and decremented inFlight), and it only closes when no
 *  NEWER op is queued behind it. */
export async function dropProject(projectPath: string): Promise<void> {
  const key = norm(projectPath);
  await withLock(key, async () => {
    // Signal any in-flight reindex loop that this project was dropped, so it aborts
    // instead of indexing further directories into a now-disabled project.
    //
    // Bumped BEFORE the deferral check below, and unconditionally: the generation's
    // job is to tell the reindex loop to stop, which is true regardless of whether
    // we can safely close right now. Bumping it only on the closing path meant the
    // common case — a drop arriving WHILE a directory is being indexed, so inFlight
    // is non-zero and we defer — never signalled the loop at all, and the reindex
    // ran to completion against the project the user had just disabled.
    generations.set(key, (generations.get(key) ?? 0) + 1);

    // By the time this runs, every op queued before it has completed and
    // decremented inFlight. A residual inFlight > 0 means a NEWER op enqueued
    // behind us — closing would race it, so defer (the idle sweeper or a later
    // drop finalizes the close once the project is truly idle).
    const u = usage.get(key);
    if (u && u.inFlight > 0) {
      log.info('codemogger.drop', 'deferred close (op in flight)', { data: { key, inFlight: u.inFlight } });
      return;
    }
    const p = registry.get(key);
    registry.delete(key);
    usage.delete(key);
    if (p) { try { (await p).codeIndex.close(); } catch { /* already closed / never opened */ } }
  });
  // Deliberately DO NOT locks.delete(key) here: deleting the chain while an op may
  // still reference it is exactly the reset that de-serialized the next op (P4).
  // Leaving the resolved lock promise keeps future ops chained; it's a bounded,
  // tiny per-project entry (reused by withLock, cleared by evictIdle when idle).
}

// ── Idle eviction ───────────────────────────────────────────────────────────────
// A long-lived server that code-searches many projects would otherwise accumulate
// open Turso connections (one CodeIndex per project, closed only on disable/shutdown).
// Close a project's connection once it's been idle a while; getOrCreate re-opens it on
// the next access. Safe because we only evict when inFlight === 0 (no op mid-use).
const IDLE_TTL_MS = 15 * 60_000;   // evict a project's index after this much idle time
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Close every project whose index has been idle ≥ ttlMs and has no op in flight.
 *  Returns the number evicted. Exported (with a ttl arg) so tests can force a sweep. */
export function evictIdle(ttlMs: number = IDLE_TTL_MS): number {
  const now = Date.now();
  let evicted = 0;
  for (const [key, u] of usage) {
    if (u.inFlight !== 0 || now - u.lastUsed < ttlMs) continue;
    const p = registry.get(key);
    registry.delete(key);
    locks.delete(key);
    usage.delete(key);
    if (p) p.then(e => { try { e.codeIndex.close(); } catch { /* already closed */ } }, () => {});
    evicted++;
    log.info('codemogger.evict', 'closed idle project index', { data: { key, idleMs: now - u.lastUsed } });
  }
  return evicted;
}

/**
 * Close EVERY open project engine and release its DB connection. For graceful
 * server shutdown: a lingering open `index.db` keeps the process holding that file,
 * which on Windows blocks removal of the containing project dir (the e2e scratch-dir
 * cleanup depends on this). Unlike evictIdle's fire-and-forget close, this AWAITS
 * each close so the caller can act once the handles are released. Best-effort per
 * engine; returns how many it closed.
 */
export async function closeAllEngines(): Promise<number> {
  let closed = 0;
  for (const key of [...registry.keys()]) {
    const p = registry.get(key);
    registry.delete(key);
    locks.delete(key);
    usage.delete(key);
    if (p) { try { await (await p).codeIndex.close(); closed++; } catch { /* already closed / never opened */ } }
  }
  return closed;
}

/** Whether a project currently holds an open engine (introspection for tests). */
export function hasOpenEngine(projectPath: string): boolean {
  return registry.has(norm(projectPath));
}

// One sweep timer across HMR re-evals (unref'd so it never keeps the process alive).
{
  const g = globalThis as unknown as { __fury_codemogger_sweep__?: ReturnType<typeof setInterval> };
  if (g.__fury_codemogger_sweep__) clearInterval(g.__fury_codemogger_sweep__);
  const t = setInterval(() => evictIdle(), SWEEP_INTERVAL_MS);
  if (typeof t.unref === 'function') t.unref();
  g.__fury_codemogger_sweep__ = t;
}
