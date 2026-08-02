/**
 * Live integration drive for the auto-reindex watcher
 * (docs/ticket-local-mcp-this-project-fails-first-use.md → Index freshness).
 *
 * Proves the real path end-to-end WITHOUT any Claude turn (no tokens — it only
 * spawns codemogger locally): watch a codemogger-configured project, add a new
 * source symbol, and confirm the debounced reindex makes it searchable.
 *
 *   1. scratch project with a codemogger `.mcp.json` (`--db <tmp>`), one source file.
 *   2. initial `codemogger index` → the new symbol is NOT yet present.
 *   3. CodemoggerReindexer.ensureWatching(project) (real fs.watch, short debounce).
 *   4. write a file with a distinctive symbol → fs.watch fires → debounced reindex.
 *   5. poll `codemogger search` until the symbol appears (or time out).
 *
 * COST/TIME: spawns codemogger (loads the local embedder) several times — budget
 * ~1 min, but ZERO tokens. Lives in tests/live-sessions (the costly bucket).
 */
import { test, expect } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CodemoggerReindexer, RECURSIVE_WATCH_SUPPORTED } from '../../lib/codemoggerReindex';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CLI = join(__dirname, '..', '..', 'node_modules', 'codemogger', 'dist', 'cli.mjs');

function codemogger(args: string[]) {
  return execFileAsync(process.execPath, [CLI, ...args], { timeout: 120_000 });
}

/** Number of keyword-search hits for `symbol` in `db` (parses codemogger's JSON —
 *  a substring check would false-match its echoed `"query"` field). */
async function searchHits(db: string, symbol: string): Promise<number> {
  const res = await codemogger(['--db', db, 'search', symbol, '--mode', 'keyword'])
    .catch(() => ({ stdout: '{"results":[]}' }));
  try { return (JSON.parse(res.stdout).results || []).length; } catch { return 0; }
}

test('auto-reindex: a source change becomes searchable without a manual reindex', async () => {
  test.skip(!RECURSIVE_WATCH_SUPPORTED, 'recursive fs.watch (auto-reindex) is macOS/Windows only');
  test.setTimeout(3 * 60 * 1000);

  const project = mkdtempSync(join(tmpdir(), 'fury-reindex-live-'));
  const db = join(project, '.codemogger', 'index.db');
  const reindexer = new CodemoggerReindexer({ debounceMs: 300 });

  try {
    // A codemogger-configured project (what "This project" writes).
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', db, 'mcp'] } },
    }, null, 2));
    // Create the --db parent dir (the real route does this via ensureDbParentDir /
    // B1; codemogger won't mkdir an explicit --db parent, so a direct index would
    // otherwise crash "entity not found"). Then seed source + build the initial index.
    mkdirSync(dirname(db), { recursive: true });
    writeFileSync(join(project, 'alpha.ts'), 'export function alphaOriginalSymbol() { return 1; }\n');
    await codemogger(['--db', db, 'index', project]);

    // Distinctive symbol not in the index yet.
    const SYMBOL = 'zetaFreshlyAddedReindexProbe';
    expect(await searchHits(db, SYMBOL), 'symbol absent before the change').toBe(0);

    // Start watching, then add a file with the new symbol.
    reindexer.ensureWatching(project);
    expect(reindexer.isWatching(project)).toBe(true);
    writeFileSync(join(project, 'beta.ts'), `export function ${SYMBOL}(x: number) { return x * 7; }\n`);

    // Poll search until the debounced auto-reindex has picked it up.
    let found = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (await searchHits(db, SYMBOL) > 0) { found = true; break; }
    }
    expect(found, `auto-reindex should make ${SYMBOL} searchable after the file change`).toBe(true);
  } finally {
    reindexer.stopAll();
    await sleep(200);
    try { rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
