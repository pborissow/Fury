/**
 * Live integration drive for the auto-reindex watcher, IN-PROCESS
 * (docs/ticket-codesearch-inprocess-mcp-macos-contention.md → Option A).
 *
 * Proves the real path end-to-end WITHOUT any Claude turn (no tokens) and WITHOUT a
 * separate codemogger process — one process holds the DB (acceptance #1): enable code
 * search for a scratch project, add a new source symbol, and confirm the debounced
 * IN-PROCESS reindex makes it searchable via `searchProject` (same connection).
 *
 *   1. scratch project with code search enabled + one source file.
 *   2. initial in-process index → the new symbol is NOT yet present.
 *   3. CodemoggerReindexer.ensureWatching(project) (real fs.watch, short debounce).
 *   4. write a file with a distinctive symbol → fs.watch fires → debounced reindex.
 *   5. poll searchProject until the symbol appears (or time out).
 *
 * COST/TIME: loads the embedder + Turso in THIS process (once) — budget ~1 min, ZERO
 * tokens. Lives in tests/live-sessions (the costly bucket).
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodemoggerReindexer, RECURSIVE_WATCH_SUPPORTED } from '../../lib/codemoggerReindex';
import { reindexProject, searchProject, dropProject } from '../../lib/codemoggerServer';
import { writeCodeSearchConfig, codeSearchDbPath } from '../../lib/codeSearchConfig';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** In-process keyword-search hit count for `symbol` in the project's index. */
async function searchHits(project: string, symbol: string): Promise<number> {
  const hits = await searchProject(project, codeSearchDbPath(project), symbol, { mode: 'keyword' })
    .catch(() => []);
  return hits.length;
}

test('auto-reindex (in-process): a source change becomes searchable without a manual reindex', async () => {
  test.skip(!RECURSIVE_WATCH_SUPPORTED, 'recursive fs.watch (auto-reindex) is macOS/Windows only');
  test.setTimeout(3 * 60 * 1000);

  const project = mkdtempSync(join(tmpdir(), 'fury-reindex-live-'));
  const db = codeSearchDbPath(project);
  // Real default reindexer (calls reindexProject in-process); short debounce for the test.
  const reindexer = new CodemoggerReindexer({ debounceMs: 300 });

  try {
    // Enable code search (what "This project" writes) and seed the initial index.
    writeCodeSearchConfig(project, [project]);
    writeFileSync(join(project, 'alpha.ts'), 'export function alphaOriginalSymbol() { return 1; }\n');
    await reindexProject(project, db, [project]);

    // Distinctive symbol not in the index yet.
    const SYMBOL = 'zetaFreshlyAddedReindexProbe';
    expect(await searchHits(project, SYMBOL), 'symbol absent before the change').toBe(0);

    // Start watching, then add a file with the new symbol.
    reindexer.ensureWatching(project);
    expect(reindexer.isWatching(project)).toBe(true);
    writeFileSync(join(project, 'beta.ts'), `export function ${SYMBOL}(x: number) { return x * 7; }\n`);

    // Poll search until the debounced auto-reindex has picked it up.
    let found = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (await searchHits(project, SYMBOL) > 0) { found = true; break; }
    }
    expect(found, `auto-reindex should make ${SYMBOL} searchable after the file change`).toBe(true);
  } finally {
    reindexer.stopAll();
    await sleep(200);
    await dropProject(project); // close the DB connection before cleanup
    try { rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
