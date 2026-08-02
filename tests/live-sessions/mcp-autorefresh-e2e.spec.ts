/**
 * FULL end-to-end drive for the "This project" code-search auto-refresh
 * (docs/ticket-local-mcp-this-project-fails-first-use.md → Index freshness).
 *
 * Exercises the whole chain through the REAL server: register codemogger for a
 * project (POST /api/mcp → B1 dir + B2 approve), start a Fury SDK session (whose
 * turn starts the server-side auto-reindex watcher via sendMessage→ensureWatching),
 * then cover BOTH kinds of change the watcher must handle:
 *   1a. CREATE a new source file  → auto-indexed; a real Claude turn finds the symbol
 *       via `mcp__codemogger__codemogger_search` (grounded answer proves it read the
 *       freshly-refreshed index).
 *   1b. DELETE that file          → dropped from the index.
 *   2a. ADD code to an EXISTING, already-indexed file (an in-place `change`, not a
 *       create) → the new symbol is auto-indexed and the file's other symbols survive.
 *   2b. REMOVE that code from the existing file → the symbol is dropped, siblings kept.
 *
 * Uses a snake_case name (`compute_purple_platypus_quotient`) on purpose — see the
 * tokenization note below. The reindex assertions search a SUB-TOKEN in keyword mode
 * and the exact name in semantic mode, because codemogger's `default` FTS silently
 * drops an underscored *keyword* query longer than ~25–31 chars (Turso tokenizer),
 * so the exact snake_case name in keyword mode is an unreliable probe. Semantic mode
 * and sub-tokens are unaffected — which is also why the Claude turn asks for SEMANTIC.
 *
 * COST/TIME: two real Claude turns (a trivial warmup + the search) + local codemogger
 * runs. Skips on Linux (recursive fs.watch, hence auto-reindex, is macOS/Windows only).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  BASE_URL, sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn,
  cleanupSession, jsonlPath,
} from './drive-helpers';
import { RECURSIVE_WATCH_SUPPORTED } from '../../lib/codemoggerReindex';

const execFileAsync = promisify(execFile);
const CLI = join(__dirname, '..', '..', 'node_modules', 'codemogger', 'dist', 'cli.mjs');
const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-refresh');
const SERVER_NAME = 'codemogger';
// Scenario 1 — a brand-NEW file (create/delete).
const NEW_FILE = 'platypus.ts';
const NEW_SYMBOL = 'compute_purple_platypus_quotient';
const NEW_SUBTOKEN = 'platypus';
// Scenario 2 — a function added to / removed from an EXISTING, already-indexed file.
const EXISTING_FILE = 'base.ts';
const EXISTING_SYMBOL = 'tangerine_marmalade_index';
const EXISTING_SUBTOKEN = 'tangerine';
const BASELINE_SUBTOKEN = 'baseline'; // sub-token of the always-present base function
const BASE_ONLY = 'export function seed_baseline_function() { return 0; }\n';
const BASE_PLUS = BASE_ONLY +
  `export function ${EXISTING_SYMBOL}(n: number): number {\n  // returns 99 times the input\n  return n * 99;\n}\n`;

/** Keyword-search hit count on the scratch DB (parses codemogger JSON). */
async function keywordHits(db: string, query: string): Promise<number> {
  const res = await execFileAsync(process.execPath, [CLI, '--db', db, 'search', query, '--mode', 'keyword'], { timeout: 60_000 })
    .catch(() => ({ stdout: '{"results":[]}' }));
  try { return (JSON.parse(res.stdout).results || []).length; } catch { return 0; }
}

async function registerCodemogger(project: string, args: string[]): Promise<Response> {
  return fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: SERVER_NAME, transport: 'stdio', commandOrUrl: 'codemogger', args, scope: 'project', projectPath: project }),
  });
}

async function removeServer(project: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/mcp`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: SERVER_NAME, projectPath: project }) });
  } catch { /* best effort */ }
  try {
    const { homedir } = await import('os');
    const cj = join(homedir(), '.claude.json');
    if (existsSync(cj)) {
      const cfg = JSON.parse(readFileSync(cj, 'utf8'));
      const key = project.replace(/\\/g, '/');
      if (cfg.projects?.[key]) { delete cfg.projects[key]; writeFileSync(cj, JSON.stringify(cfg, null, 2)); }
    }
  } catch { /* best effort */ }
}

function toolUsesIn(sessionId: string): string[] {
  const p = jsonlPath(sessionId, PROJECT);
  if (!p || !existsSync(p)) return [];
  const names: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line)?.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use' && typeof b.name === 'string') names.push(b.name);
    } catch { /* partial */ }
  }
  return names;
}

function assistantTextIn(sessionId: string): string {
  const p = jsonlPath(sessionId, PROJECT);
  if (!p || !existsSync(p)) return '';
  let out = '';
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== 'assistant') continue;
      const c = e?.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') out += b.text + '\n';
    } catch { /* partial */ }
  }
  return out;
}

/** Raw fury-log entries (NOT sessionId-scoped) — the watcher logs are keyed on
 *  project, not session. */
function furyLogsRaw(): any[] {
  const dir = join(homedir(), '.claude', 'fury-logs');
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* partial */ }
    }
  }
  return out;
}

async function waitTurnDone(sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const start = furyLogLinesFor(sessionId).filter(e => e.scope === 'sdk.turn' && String(e.msg).startsWith('done')).length;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (furyLogLinesFor(sessionId).filter(e => e.scope === 'sdk.turn' && String(e.msg).startsWith('done')).length > start) return;
  }
}

/** Poll the scratch DB until `predicate(hits)` for `query` (keyword) holds, or time out. */
async function waitForIndex(db: string, query: string, predicate: (hits: number) => boolean, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let hits = await keywordHits(db, query);
  while (Date.now() < deadline) {
    if (predicate(hits)) return hits;
    await sleep(3000);
    hits = await keywordHits(db, query);
  }
  return hits;
}

test.describe('This project code-search — auto-refresh (full e2e)', () => {
  let sessionId: string | null = null;
  const db = join(PROJECT, '.codemogger', 'index.db');

  test.afterAll(async () => {
    await cleanupSession(sessionId, PROJECT);
    await removeServer(PROJECT);
    try { rmSync(PROJECT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('auto-refresh on new-file create/delete AND in-file code add/remove; Claude finds a fresh symbol', async () => {
    test.skip(!RECURSIVE_WATCH_SUPPORTED, 'auto-reindex (recursive fs.watch) is macOS/Windows only');
    test.setTimeout(8 * 60 * 1000);

    sessionId = randomUUID();
    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-refresh'));
    await resetProjectDir(PROJECT);
    console.log(`[E2E] session=${sessionId} project=${PROJECT}`);

    await test.step('setup: register codemogger, seed index, start the server watcher', async () => {
      // Register codemogger (real route: B1 dir + B2 approve) and seed a base index
      // from an EXISTING file that scenario 2 will later mutate in place.
      writeFileSync(join(PROJECT, EXISTING_FILE), BASE_ONLY);
      const reg = await registerCodemogger(PROJECT, ['--db', db, 'mcp']);
      expect(reg.ok, 'POST /api/mcp registered codemogger').toBe(true);
      expect(existsSync(join(PROJECT, '.codemogger')), 'B1: --db parent dir created').toBe(true);
      await execFileAsync(process.execPath, [CLI, '--db', db, 'index', PROJECT], { timeout: 120_000 });
      expect(await keywordHits(db, NEW_SUBTOKEN), 'new-file symbol absent before it is written').toBe(0);
      expect(await keywordHits(db, EXISTING_SUBTOKEN), 'in-file symbol absent before it is added').toBe(0);

      // Warmup turn — starts the SERVER-SIDE watcher (sendMessage → ensureWatching).
      await driveTurn(sessionId!, PROJECT, 'Reply with exactly the word: ready.');
      await waitTurnDone(sessionId!, 90_000);
      await sleep(2000); // let ensureWatching attach
      // The watcher log is keyed on project, not session. Informational — the reindex
      // assertions below are the real proof. (If false, the dev server is likely on a
      // pre-v32 singleton without ensureWatching in sendMessage — restart it.)
      const watching = furyLogsRaw().some(e => e.scope === 'codemogger.reindex' && e.msg === 'watching'
        && String(e?.data?.project || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-refresh'));
      console.log('[E2E] server auto-reindex watcher attached:', watching);
      await sleep(1500);
    });

    await test.step('scenario 1a — CREATE a new source file → auto-indexed', async () => {
      writeFileSync(join(PROJECT, NEW_FILE),
        `export function ${NEW_SYMBOL}(n: number): number {\n  // returns 42 times the input\n  return n * 42;\n}\n`);
      const hits = await waitForIndex(db, NEW_SUBTOKEN, h => h > 0, 60_000);
      expect(hits, `auto-reindex made "${NEW_SUBTOKEN}" searchable after CREATE`).toBeGreaterThan(0);

      // Tokenization note (the snake_case question), asserted live on the fresh index:
      // exact underscored name in KEYWORD mode returns nothing (>~30 chars); SEMANTIC finds it.
      const kwExact = await keywordHits(db, NEW_SYMBOL);
      const semExact = await execFileAsync(process.execPath, [CLI, '--db', db, 'search', NEW_SYMBOL, '--mode', 'semantic'], { timeout: 60_000 })
        .then(r => (JSON.parse(r.stdout).results || []).some((x: any) => x.name === NEW_SYMBOL)).catch(() => false);
      console.log(`[E2E] snake_case: keyword-exact hits=${kwExact} (expected 0 — FTS length quirk), semantic-finds-exact=${semExact}`);
      expect(semExact, 'semantic search finds the exact snake_case name').toBe(true);
    });

    await test.step('scenario 1a — Claude uses codemogger_search to find the fresh symbol', async () => {
      const findId = randomUUID();
      try {
        await driveTurn(findId, PROJECT,
          `Use the codemogger_search MCP tool in SEMANTIC mode to find the function ${NEW_SYMBOL} in this project. ` +
          `In one sentence, tell me the number it returns for its input and which file defines it. Do not modify any files.`);
        await waitTurnDone(findId, 150_000);
        const tools = toolUsesIn(findId);
        console.log('[E2E] find-turn tools:', tools);
        expect(tools, 'Claude called codemogger_search').toContain('mcp__codemogger__codemogger_search');
        const answer = assistantTextIn(findId);
        console.log('[E2E] answer:\n' + answer.slice(0, 500));
        expect(answer, 'answer is grounded in the found function (returns 42 · platypus.ts)').toMatch(/42/);
        expect(answer).toMatch(/platypus/i);
      } finally {
        await cleanupSession(findId, PROJECT);
      }
    });

    await test.step('scenario 1b — DELETE the source file → dropped from the index', async () => {
      rmSync(join(PROJECT, NEW_FILE));
      const hits = await waitForIndex(db, NEW_SUBTOKEN, h => h === 0, 60_000);
      expect(hits, `auto-reindex removed "${NEW_SUBTOKEN}" after DELETE`).toBe(0);
    });

    await test.step('scenario 2a — ADD code to an EXISTING indexed file → auto-indexed', async () => {
      // Modify base.ts in place (a change event, not a create) — appends a new function.
      writeFileSync(join(PROJECT, EXISTING_FILE), BASE_PLUS);
      const hits = await waitForIndex(db, EXISTING_SUBTOKEN, h => h > 0, 60_000);
      expect(hits, `auto-reindex indexed "${EXISTING_SUBTOKEN}" added to an existing file`).toBeGreaterThan(0);
      // The pre-existing symbol in the same file is still indexed (incremental re-chunk).
      expect(await keywordHits(db, BASELINE_SUBTOKEN), 'the pre-existing function survived the re-index').toBeGreaterThan(0);
    });

    await test.step('scenario 2b — REMOVE code from the existing file → dropped from the index', async () => {
      // Rewrite base.ts back to just the baseline (removes the added function).
      writeFileSync(join(PROJECT, EXISTING_FILE), BASE_ONLY);
      const hits = await waitForIndex(db, EXISTING_SUBTOKEN, h => h === 0, 60_000);
      expect(hits, `auto-reindex dropped "${EXISTING_SUBTOKEN}" after it was removed from the file`).toBe(0);
      // The untouched baseline function is still there.
      expect(await keywordHits(db, BASELINE_SUBTOKEN), 'baseline function still indexed').toBeGreaterThan(0);
    });
  });
});
