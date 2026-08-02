/**
 * Auto-reindex watcher (docs/ticket-codesearch-inprocess-mcp-macos-contention.md →
 * Option A). Covers the pure helpers and the debounce + single-flight orchestration
 * WITHOUT touching fs.watch or loading the embedder (an injected `reindex`). The real
 * watch→in-process-reindex→searchable path is a live integration drive
 * (tests/live-sessions/codemogger-reindex-watch.spec.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isIndexableChange, CodemoggerReindexer, IGNORE_DIRS, RECURSIVE_WATCH_SUPPORTED,
} from '../../lib/codemoggerReindex';
import { writeCodeSearchConfig, codeSearchDbPath } from '../../lib/codeSearchConfig';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

/** A scratch project with code search ENABLED (the in-process config written), so
 *  runReindex resolves a db + dirs and actually invokes the injected `reindex`. */
async function codeSearchProject(selectedDirs?: string[]): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'fury-reindex-'));
  dirs.push(base);
  writeCodeSearchConfig(base, selectedDirs ?? []);
  return base;
}

describe('isIndexableChange', () => {
  it('true for source files codemogger indexes', () => {
    for (const f of ['a.ts', 'src/b.tsx', 'lib\\c.js', 'x/y/z.py', 'main.go', 'A.java', 'r.rs'])
      expect(isIndexableChange(f), f).toBe(true);
  });
  it('false for non-source extensions', () => {
    for (const f of ['README.md', 'data.json', 'style.css', 'img.png', 'a.txt', 'x.lock'])
      expect(isIndexableChange(f), f).toBe(false);
  });
  it('false under an ignored directory (node_modules, .git, dist, .codemogger, .next)', () => {
    for (const f of ['node_modules/pkg/a.ts', 'a/.git/b.js', 'dist/out.js', '.codemogger/x.ts', '.next/y.tsx'])
      expect(isIndexableChange(f), f).toBe(false);
    expect(IGNORE_DIRS.has('node_modules')).toBe(true);
  });
  it('false for null/empty (fs.watch can report null filename)', () => {
    expect(isIndexableChange(null)).toBe(false);
    expect(isIndexableChange(undefined)).toBe(false);
    expect(isIndexableChange('')).toBe(false);
  });
});

describe('debounce + single-flight orchestration', () => {
  it('coalesces a burst of changes into ONE reindex', async () => {
    const proj = await codeSearchProject();
    const reindex = vi.fn(async (_p: string, _db: string, _dirs: string[]) => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, reindex });
    r.scheduleReindex(proj);
    r.scheduleReindex(proj);
    r.scheduleReindex(proj);
    await sleep(60);
    expect(reindex).toHaveBeenCalledTimes(1);
  });

  it('never runs two reindexes at once; a change mid-run re-runs exactly once after', async () => {
    const proj = await codeSearchProject();
    const resolvers: Array<() => void> = [];
    const reindex = vi.fn((_p: string, _db: string, _dirs: string[]) => new Promise<void>(res => resolvers.push(res)));
    const r = new CodemoggerReindexer({ debounceMs: 20, reindex });

    r.scheduleReindex(proj);
    await sleep(40);
    expect(reindex, 'first run started').toHaveBeenCalledTimes(1);

    // A change while the first run is still in flight — must NOT start a 2nd run.
    r.scheduleReindex(proj);
    await sleep(40);
    expect(reindex, 'single-flight: coalesced into dirty').toHaveBeenCalledTimes(1);

    resolvers.shift()!();          // finish run 1
    await sleep(60);
    expect(reindex, 'dirty triggered exactly one follow-up run').toHaveBeenCalledTimes(2);

    resolvers.forEach(res => res()); // settle
  });

  it('separate projects reindex independently', async () => {
    const a = await codeSearchProject();
    const b = await codeSearchProject();
    const reindex = vi.fn(async (_p: string, _db: string, _dirs: string[]) => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, reindex });
    r.scheduleReindex(a);
    r.scheduleReindex(b);
    await sleep(60);
    expect(reindex).toHaveBeenCalledTimes(2);
    expect(reindex.mock.calls.map(c => c[0]).sort()).toEqual([a, b].sort());
  });
});

describe('reindex targets the project DB + selected directories', () => {
  it('passes the per-project DB and the selected dirs to the engine', async () => {
    const project = await mkdtemp(join(tmpdir(), 'fury-reindex-'));
    dirs.push(project);
    const src = join(project, 'src'); const ui = join(project, 'ui');
    const { mkdirSync } = await import('fs');
    mkdirSync(src, { recursive: true }); mkdirSync(ui, { recursive: true });
    writeCodeSearchConfig(project, [src, ui]);

    const reindex = vi.fn(async (_p: string, _db: string, _dirs: string[]) => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, reindex });
    await r.reindexNow(project);

    // ONE reindex call for the project, carrying the per-project DB + both dirs.
    expect(reindex).toHaveBeenCalledTimes(1);
    const [p, db, passedDirs] = reindex.mock.calls[0];
    expect(p).toBe(project);
    expect(db).toBe(codeSearchDbPath(project));
    expect([...passedDirs].sort()).toEqual([src, ui].sort());
  });

  it('does not reindex a project without code search enabled', async () => {
    const project = await mkdtemp(join(tmpdir(), 'fury-reindex-'));
    dirs.push(project); // no writeCodeSearchConfig → disabled
    const reindex = vi.fn(async () => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, reindex });
    await r.reindexNow(project);
    expect(reindex).not.toHaveBeenCalled();
  });
});

describe('ensureWatching', () => {
  it('does nothing for a project without code search enabled', async () => {
    const p = await mkdtemp(join(tmpdir(), 'fury-reindex-'));
    dirs.push(p);
    const r = new CodemoggerReindexer({ reindex: async () => {} });
    r.ensureWatching(p);
    expect(r.isWatching(p)).toBe(false);
    r.stopAll();
  });

  // Recursive fs.watch is macOS/Windows only — the "watches" assertion only holds
  // where it's supported (would fail on Linux CI where fs.watch throws).
  it.skipIf(!RECURSIVE_WATCH_SUPPORTED)('watches a code-search-enabled project and is idempotent', async () => {
    const p = await codeSearchProject([]); // empty dirs → watch the project root
    const r = new CodemoggerReindexer({ reindex: async () => {} });
    r.ensureWatching(p);
    expect(r.isWatching(p)).toBe(true);
    r.ensureWatching(p); // idempotent — no throw, still one watcher
    expect(r.isWatching(p)).toBe(true);
    r.stopWatching(p);
    expect(r.isWatching(p)).toBe(false);
    r.stopAll();
  });

  it.skipIf(RECURSIVE_WATCH_SUPPORTED)('no-ops (does not watch) where recursive fs.watch is unavailable', async () => {
    const p = await codeSearchProject([]);
    const r = new CodemoggerReindexer({ reindex: async () => {} });
    r.ensureWatching(p);
    expect(r.isWatching(p)).toBe(false); // gated off on this platform, no throw
    r.stopAll();
  });
});
