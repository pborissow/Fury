/**
 * Initial-attach failure recovery (lib/treeWatchers.ts).
 *
 * A transient `fs.watch` failure — EMFILE under descriptor pressure (macOS
 * defaults are low), or a directory caught mid-rename — used to be permanent:
 * `watch()` handed back a no-op unsubscribe, and callers that record the handle
 * (app/api/tree/watch/route.ts `subscribeDir`) then skip re-subscribing that
 * dir, so it stayed unwatched for the life of the SSE connection. The entry is
 * now kept and retried with backoff instead.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { treeWatchers } from '../../lib/treeWatchers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  treeWatchers.stopAll();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratchDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'fury-rearm-'));
  dirs.push(d);
  return d;
}

describe('treeWatchers initial-attach failure', () => {
  it('keeps the subscription and re-attaches after a transient fs.watch failure', async () => {
    const dir = await scratchDir();

    // Fail only the first attach, as EMFILE would.
    const real = fs.watch;
    let calls = 0;
    vi.spyOn(fs, 'watch').mockImplementation(((...args: unknown[]) => {
      if (++calls === 1) {
        const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
        err.code = 'EMFILE';
        throw err;
      }
      return (real as unknown as (...a: unknown[]) => fs.FSWatcher)(...args);
    }) as typeof fs.watch);

    const seen: string[] = [];
    const un = treeWatchers.watch(dir, {}, (kind) => seen.push(kind));

    // Registered despite the failure — so the caller's `dirs` handle is real
    // and a later re-subscribe isn't skipped — but not yet attached.
    expect(treeWatchers.isWatching(dir)).toBe(true);
    expect(treeWatchers.isAttached(dir)).toBe(false);

    // The rearm timer fires at ~1s.
    await sleep(1400);
    expect(treeWatchers.isAttached(dir)).toBe(true);

    // And it actually delivers events once re-attached.
    await writeFile(join(dir, 'after-rearm.txt'), 'x');
    await sleep(300);
    expect(seen.length).toBeGreaterThan(0);

    un();
    expect(treeWatchers.isWatching(dir)).toBe(false);
  }, 10_000);

  it('unsubscribing before the retry succeeds drops the entry and stops retrying', async () => {
    const dir = await scratchDir();

    vi.spyOn(fs, 'watch').mockImplementation((() => {
      const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    }) as typeof fs.watch);

    const un = treeWatchers.watch(dir, {}, () => {});
    expect(treeWatchers.isWatching(dir)).toBe(true);

    un();
    // Last subscriber left: the entry goes immediately, and the pending rearm
    // timer must not resurrect it.
    expect(treeWatchers.isWatching(dir)).toBe(false);
    await sleep(1400);
    expect(treeWatchers.isWatching(dir)).toBe(false);
    expect(treeWatchers.watchedDirCount()).toBe(0);
  }, 10_000);
});
