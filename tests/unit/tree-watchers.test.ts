/**
 * Ref-counted, deduplicated tree-watch registry (lib/treeWatchers.ts).
 *
 * The key property (docs/ticket-filetree-lazy-load-and-watcher-dedup.md §5.5,
 * G4): two subscribers on the SAME directory — e.g. two sessions viewing the
 * same open folder — share ONE fs.FSWatcher, and it closes only when the last
 * subscriber leaves. Also verifies a real write fans out to every subscriber.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { treeWatchers } from '../../lib/treeWatchers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratchDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'fury-treewatch-'));
  dirs.push(d);
  return d;
}

describe('treeWatchers ref-counting / dedup', () => {
  it('two subscribers on one dir share a single watcher; it closes only on the last unsubscribe', async () => {
    const dir = await scratchDir();

    expect(treeWatchers.isWatching(dir)).toBe(false);

    const un1 = treeWatchers.watch(dir, {}, () => {});
    expect(treeWatchers.isWatching(dir)).toBe(true);
    expect(treeWatchers.watchedDirCount()).toBe(1);
    expect(treeWatchers.subscriberCount(dir)).toBe(1);

    // Second subscriber (the "second session") — still ONE underlying watcher.
    const un2 = treeWatchers.watch(dir, {}, () => {});
    expect(treeWatchers.watchedDirCount()).toBe(1);
    expect(treeWatchers.subscriberCount(dir)).toBe(2);

    // First leaves — watcher stays because the second is still subscribed.
    un1();
    expect(treeWatchers.isWatching(dir)).toBe(true);
    expect(treeWatchers.subscriberCount(dir)).toBe(1);

    // Last leaves — watcher is closed and the entry is gone.
    un2();
    expect(treeWatchers.isWatching(dir)).toBe(false);
    expect(treeWatchers.watchedDirCount()).toBe(0);
  });

  it('distinct dirs get distinct watchers', async () => {
    const a = await scratchDir();
    const b = await scratchDir();
    const unA = treeWatchers.watch(a, {}, () => {});
    const unB = treeWatchers.watch(b, {}, () => {});
    expect(treeWatchers.watchedDirCount()).toBe(2);
    unA();
    unB();
    expect(treeWatchers.watchedDirCount()).toBe(0);
  });

  it('fans a real file change out to every subscriber (classified as a file change)', async () => {
    const dir = await scratchDir();
    const seen1: string[] = [];
    const seen2: string[] = [];
    const un1 = treeWatchers.watch(dir, {}, (kind) => seen1.push(kind));
    const un2 = treeWatchers.watch(dir, {}, (kind) => seen2.push(kind));

    await writeFile(join(dir, 'hello.txt'), 'hi');
    await sleep(300);

    un1();
    un2();

    expect(seen1.length).toBeGreaterThan(0);
    expect(seen2.length).toBeGreaterThan(0);
    expect(seen1.every((k) => k === 'file')).toBe(true);
  });

  it('classifies events under a VCS-meta watch via classifyPrefix, not the dir basename', async () => {
    // A linked-worktree gitdir isn't named ".git", so classification must come
    // from the explicit prefix, not path.basename(dir).
    const gitDir = await scratchDir();
    const seen: string[] = [];
    const un = treeWatchers.watch(gitDir, { recursive: false, classifyPrefix: '.git' }, (kind) => seen.push(kind));

    // Writing an index/HEAD-style file must read as a 'vcs' change.
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await sleep(300);
    un();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((k) => k === 'vcs')).toBe(true);
  });

  it('unsubscribe is idempotent and does not underflow', async () => {
    const dir = await scratchDir();
    const un = treeWatchers.watch(dir, {}, () => {});
    un();
    un(); // second call is a no-op
    expect(treeWatchers.isWatching(dir)).toBe(false);
    expect(treeWatchers.watchedDirCount()).toBe(0);
  });
});
