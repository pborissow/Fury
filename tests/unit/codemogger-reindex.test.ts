/**
 * Auto-reindex watcher (docs/ticket-local-mcp-this-project-fails-first-use.md →
 * Index freshness). Covers the pure helpers and the debounce + single-flight
 * orchestration without touching fs.watch or spawning codemogger (an injected
 * runIndex). The real watch→reindex→searchable path is a live integration drive
 * (tests/live-sessions/codemogger-reindex-watch.spec.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  isIndexableChange, readCodemoggerDbPath, CodemoggerReindexer, IGNORE_DIRS,
  RECURSIVE_WATCH_SUPPORTED, writeIndexDirs, readIndexDirs,
} from '../../lib/codemoggerReindex';
import { mkdirSync } from 'fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function scratchProject(mcpJson?: unknown): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'fury-reindex-'));
  dirs.push(base);
  if (mcpJson !== undefined) await writeFile(join(base, '.mcp.json'), JSON.stringify(mcpJson, null, 2));
  return base;
}

/** A scratch project WITH a codemogger server, so runReindex resolves a db and
 *  actually invokes the injected runIndex (it re-resolves the db each run and
 *  bails if codemogger isn't configured — the real behavior). */
async function codemoggerProject(): Promise<string> {
  return scratchProject({
    mcpServers: { codemogger: { command: 'codemogger', args: ['--db', '/tmp/i.db', 'mcp'] } },
  });
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
    // sanity: the ignore set is the source of truth
    expect(IGNORE_DIRS.has('node_modules')).toBe(true);
  });
  it('false for null/empty (fs.watch can report null filename)', () => {
    expect(isIndexableChange(null)).toBe(false);
    expect(isIndexableChange(undefined)).toBe(false);
    expect(isIndexableChange('')).toBe(false);
  });
});

describe('readCodemoggerDbPath', () => {
  it('returns the explicit --db path from a codemogger stdio server', async () => {
    const p = await scratchProject({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', 'C:/Users/x/.codemogger/index.db', 'mcp'] } },
    });
    expect(readCodemoggerDbPath(p)).toBe('C:/Users/x/.codemogger/index.db');
  });
  it('detects by command even when the server is renamed', async () => {
    const p = await scratchProject({
      mcpServers: { 'my-search': { command: 'codemogger', args: ['--db', '/tmp/i.db', 'mcp'] } },
    });
    expect(readCodemoggerDbPath(p)).toBe('/tmp/i.db');
  });
  it('falls back to the default db when codemogger has no --db', async () => {
    const p = await scratchProject({ mcpServers: { codemogger: { command: 'codemogger', args: ['mcp'] } } });
    expect(readCodemoggerDbPath(p)).toBe(join(homedir(), '.codemogger', 'index.db'));
  });
  it('null when no codemogger server / no .mcp.json', async () => {
    const p1 = await scratchProject({ mcpServers: { other: { command: 'some-tool', args: [] } } });
    expect(readCodemoggerDbPath(p1)).toBeNull();
    const p2 = await scratchProject(); // no .mcp.json
    expect(readCodemoggerDbPath(p2)).toBeNull();
  });
});

describe('debounce + single-flight orchestration', () => {
  it('coalesces a burst of changes into ONE reindex', async () => {
    const proj = await codemoggerProject();
    const runIndex = vi.fn(async (_p: string, _db: string) => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, runIndex });
    r.scheduleReindex(proj);
    r.scheduleReindex(proj);
    r.scheduleReindex(proj);
    await sleep(60);
    expect(runIndex).toHaveBeenCalledTimes(1);
  });

  it('never runs two reindexes at once; a change mid-run re-runs exactly once after', async () => {
    const proj = await codemoggerProject();
    const resolvers: Array<() => void> = [];
    const runIndex = vi.fn((_p: string, _db: string) => new Promise<void>(res => resolvers.push(res)));
    const r = new CodemoggerReindexer({ debounceMs: 20, runIndex });

    r.scheduleReindex(proj);
    await sleep(40);
    expect(runIndex, 'first run started').toHaveBeenCalledTimes(1);

    // A change while the first run is still in flight — must NOT start a 2nd run.
    r.scheduleReindex(proj);
    await sleep(40);
    expect(runIndex, 'single-flight: coalesced into dirty').toHaveBeenCalledTimes(1);

    resolvers.shift()!();          // finish run 1
    await sleep(60);
    expect(runIndex, 'dirty triggered exactly one follow-up run').toHaveBeenCalledTimes(2);

    resolvers.forEach(res => res()); // settle
  });

  it('separate projects reindex independently', async () => {
    const a = await codemoggerProject();
    const b = await codemoggerProject();
    const runIndex = vi.fn(async (_p: string, _db: string) => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, runIndex });
    r.scheduleReindex(a);
    r.scheduleReindex(b);
    await sleep(60);
    expect(runIndex).toHaveBeenCalledTimes(2);
    expect(runIndex.mock.calls.map(c => c[0]).sort()).toEqual([a, b].sort());
  });
});

describe('index-dirs sidecar (per-project selected directories)', () => {
  // A project whose codemogger --db is IN the project tree (per-project DB), so the
  // sidecar sits next to it — the real registration shape.
  async function perProjectCodemogger(): Promise<{ project: string; db: string }> {
    const project = await scratchProject();
    const db = join(project, '.codemogger', 'index.db');
    mkdirSync(join(project, '.codemogger'), { recursive: true });
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', db, 'mcp'] } },
    }, null, 2));
    return { project, db };
  }

  it('writeIndexDirs → readIndexDirs round-trips the selected dirs', async () => {
    const { project, db } = await perProjectCodemogger();
    writeIndexDirs(db, [join(project, 'src'), join(project, 'ui')]);
    expect(readIndexDirs(project)).toEqual([join(project, 'src'), join(project, 'ui')]);
  });

  it('falls back to the project root when there is no sidecar', async () => {
    const { project } = await perProjectCodemogger();
    expect(readIndexDirs(project)).toEqual([project]);
  });

  it('returns [] when the project has no codemogger server', async () => {
    const project = await scratchProject({ mcpServers: {} });
    expect(readIndexDirs(project)).toEqual([]);
  });
});

describe('reindex scopes to the selected directories', () => {
  it('indexes each selected dir (not the whole project)', async () => {
    const project = await scratchProject();
    const db = join(project, '.codemogger', 'index.db');
    const src = join(project, 'src'); const ui = join(project, 'ui');
    mkdirSync(join(project, '.codemogger'), { recursive: true });
    mkdirSync(src, { recursive: true }); mkdirSync(ui, { recursive: true });
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', db, 'mcp'] } },
    }, null, 2));
    writeIndexDirs(db, [src, ui]);

    const runIndex = vi.fn(async (_dir: string, _db: string) => {});
    const r = new CodemoggerReindexer({ debounceMs: 20, runIndex });
    await r.reindexNow(project);

    expect(runIndex).toHaveBeenCalledTimes(2);
    expect(runIndex.mock.calls.map(c => c[0]).sort()).toEqual([src, ui].sort());
    // All into the one per-project DB.
    expect(runIndex.mock.calls.every(c => c[1] === db)).toBe(true);
  });
});

describe('ensureWatching', () => {
  it('does nothing for a project without codemogger configured', async () => {
    const p = await scratchProject({ mcpServers: {} });
    const r = new CodemoggerReindexer({ runIndex: async () => {} });
    r.ensureWatching(p);
    expect(r.isWatching(p)).toBe(false);
    r.stopAll();
  });

  // Recursive fs.watch is macOS/Windows only — the "watches" assertion only holds
  // where it's supported (would fail on Linux CI where fs.watch throws).
  it.skipIf(!RECURSIVE_WATCH_SUPPORTED)('watches a codemogger-configured project and is idempotent', async () => {
    const p = await scratchProject({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', '/tmp/i.db', 'mcp'] } },
    });
    const r = new CodemoggerReindexer({ runIndex: async () => {} });
    r.ensureWatching(p);
    expect(r.isWatching(p)).toBe(true);
    r.ensureWatching(p); // idempotent — no throw, still one watcher
    expect(r.isWatching(p)).toBe(true);
    r.stopWatching(p);
    expect(r.isWatching(p)).toBe(false);
    r.stopAll();
  });

  it.skipIf(RECURSIVE_WATCH_SUPPORTED)('no-ops (does not watch) where recursive fs.watch is unavailable', async () => {
    const p = await scratchProject({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', '/tmp/i.db', 'mcp'] } },
    });
    const r = new CodemoggerReindexer({ runIndex: async () => {} });
    r.ensureWatching(p);
    expect(r.isWatching(p)).toBe(false); // gated off on this platform, no throw
    r.stopAll();
  });
});
