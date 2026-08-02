/**
 * FULL end-to-end drive for "This project" code-search auto-refresh, IN-PROCESS
 * (docs/ticket-codesearch-inprocess-mcp-macos-contention.md → Option A).
 *
 * Exercises the whole chain through the REAL server with ONE process owning the DB
 * (acceptance #1 + #3): enable code search for a project (POST /api/code-search →
 * config + initial in-process index), start a Fury SDK session (whose turn starts the
 * server-side auto-reindex watcher via sendMessage→ensureWatching), then cover BOTH
 * kinds of change the watcher must handle — each observed by searching THROUGH the
 * server (the single DB owner), never a second codemogger process:
 *   1a. CREATE a new source file  → auto-indexed; a real Claude turn finds the symbol
 *       via `mcp__codemogger__codemogger_search` (grounded answer proves it read the
 *       freshly-refreshed index, served in-process).
 *   1b. DELETE that file          → dropped from the index.
 *   2a. ADD code to an EXISTING, already-indexed file → the new symbol is auto-indexed
 *       and the file's other symbols survive.
 *   2b. REMOVE that code          → the symbol is dropped, siblings kept.
 *
 * Uses a snake_case name on purpose (see the tokenization note): the reindex
 * assertions search a SUB-TOKEN in keyword mode and the exact name in semantic mode,
 * because codemogger's `default` FTS silently drops an underscored *keyword* query
 * longer than ~25–31 chars — so the exact snake_case name in keyword mode is an
 * unreliable probe. Semantic mode and sub-tokens are unaffected (also why the Claude
 * turn asks for SEMANTIC).
 *
 * COST/TIME: one warmup turn + one search turn + in-process indexing; polling is
 * token-free (server search endpoint). Skips on Linux (recursive fs.watch, hence
 * auto-reindex, is macOS/Windows only).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  BASE_URL, sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn,
  cleanupSession, jsonlPath,
} from './drive-helpers';
import { RECURSIVE_WATCH_SUPPORTED } from '../../lib/codemoggerReindex';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-refresh');
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

/** Search a project's index THROUGH the dev server (the single DB owner). */
async function serverSearch(project: string, query: string, mode: 'keyword' | 'semantic'): Promise<{ name?: string }[]> {
  const url = `${BASE_URL}/api/code-search?projectPath=${encodeURIComponent(project)}&q=${encodeURIComponent(query)}&mode=${mode}`;
  const res = await fetch(url).then(r => r.json()).catch(() => ({ results: [] }));
  return Array.isArray(res.results) ? res.results : [];
}
async function keywordHits(project: string, query: string): Promise<number> {
  return (await serverSearch(project, query, 'keyword')).length;
}

async function enableCodeSearch(project: string, dirs: string[]): Promise<Response> {
  return fetch(`${BASE_URL}/api/code-search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: project, dirs }),
  });
}
async function disableCodeSearch(project: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/code-search`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project }),
    });
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

/** Poll the index (through the server) until `predicate(hits)` for `query` holds. */
async function waitForIndex(project: string, query: string, predicate: (hits: number) => boolean, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let hits = await keywordHits(project, query);
  while (Date.now() < deadline) {
    if (predicate(hits)) return hits;
    await sleep(3000);
    hits = await keywordHits(project, query);
  }
  return hits;
}

test.describe('This project code-search — auto-refresh (full e2e, in-process)', () => {
  let sessionId: string | null = null;

  test.afterAll(async () => {
    await cleanupSession(sessionId, PROJECT);
    await disableCodeSearch(PROJECT);
    try { rmSync(PROJECT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('auto-refresh on new-file create/delete AND in-file code add/remove; Claude finds a fresh symbol', async () => {
    test.skip(!RECURSIVE_WATCH_SUPPORTED, 'auto-reindex (recursive fs.watch) is macOS/Windows only');
    test.setTimeout(8 * 60 * 1000);

    sessionId = randomUUID();
    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-refresh'));
    await resetProjectDir(PROJECT);
    console.log(`[E2E] session=${sessionId} project=${PROJECT}`);

    await test.step('setup: enable code search, seed index, start the server watcher', async () => {
      // Seed a base index from an EXISTING file that scenario 2 will later mutate in place.
      writeFileSync(join(PROJECT, EXISTING_FILE), BASE_ONLY);
      const reg = await enableCodeSearch(PROJECT, [PROJECT]);
      expect(reg.ok, 'POST /api/code-search enabled code search').toBe(true);
      expect(existsSync(join(PROJECT, '.codemogger', 'fury-codesearch.json')), 'config written').toBe(true);
      // Wait for the initial in-process index to settle (baseline present).
      expect(await waitForIndex(PROJECT, BASELINE_SUBTOKEN, h => h > 0, 90_000), 'baseline indexed').toBeGreaterThan(0);
      expect(await keywordHits(PROJECT, NEW_SUBTOKEN), 'new-file symbol absent before it is written').toBe(0);
      expect(await keywordHits(PROJECT, EXISTING_SUBTOKEN), 'in-file symbol absent before it is added').toBe(0);

      // Warmup turn — starts the SERVER-SIDE watcher (sendMessage → ensureWatching).
      await driveTurn(sessionId!, PROJECT, 'Reply with exactly the word: ready.');
      await waitTurnDone(sessionId!, 90_000);
      await sleep(2000); // let ensureWatching attach
      const watching = furyLogsRaw().some(e => e.scope === 'codemogger.reindex' && e.msg === 'watching'
        && String(e?.data?.project || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-refresh'));
      console.log('[E2E] server auto-reindex watcher attached:', watching);
      await sleep(1500);
    });

    await test.step('scenario 1a — CREATE a new source file → auto-indexed', async () => {
      writeFileSync(join(PROJECT, NEW_FILE),
        `export function ${NEW_SYMBOL}(n: number): number {\n  // returns 42 times the input\n  return n * 42;\n}\n`);
      const hits = await waitForIndex(PROJECT, NEW_SUBTOKEN, h => h > 0, 60_000);
      expect(hits, `auto-reindex made "${NEW_SUBTOKEN}" searchable after CREATE`).toBeGreaterThan(0);

      // Tokenization note asserted live on the fresh index: exact underscored name in
      // KEYWORD mode returns nothing (>~30 chars); SEMANTIC finds it.
      const kwExact = await keywordHits(PROJECT, NEW_SYMBOL);
      const semExact = (await serverSearch(PROJECT, NEW_SYMBOL, 'semantic')).some(x => x.name === NEW_SYMBOL);
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
      const hits = await waitForIndex(PROJECT, NEW_SUBTOKEN, h => h === 0, 60_000);
      expect(hits, `auto-reindex removed "${NEW_SUBTOKEN}" after DELETE`).toBe(0);
    });

    await test.step('scenario 2a — ADD code to an EXISTING indexed file → auto-indexed', async () => {
      writeFileSync(join(PROJECT, EXISTING_FILE), BASE_PLUS);
      const hits = await waitForIndex(PROJECT, EXISTING_SUBTOKEN, h => h > 0, 60_000);
      expect(hits, `auto-reindex indexed "${EXISTING_SUBTOKEN}" added to an existing file`).toBeGreaterThan(0);
      // The pre-existing symbol in the same file is still indexed (incremental re-chunk).
      expect(await keywordHits(PROJECT, BASELINE_SUBTOKEN), 'the pre-existing function survived the re-index').toBeGreaterThan(0);
    });

    await test.step('scenario 2b — REMOVE code from the existing file → dropped from the index', async () => {
      writeFileSync(join(PROJECT, EXISTING_FILE), BASE_ONLY);
      const hits = await waitForIndex(PROJECT, EXISTING_SUBTOKEN, h => h === 0, 60_000);
      expect(hits, `auto-reindex dropped "${EXISTING_SUBTOKEN}" after it was removed from the file`).toBe(0);
      expect(await keywordHits(PROJECT, BASELINE_SUBTOKEN), 'baseline function still indexed').toBeGreaterThan(0);
    });
  });
});
