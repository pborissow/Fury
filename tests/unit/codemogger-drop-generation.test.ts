/**
 * A drop (code search disabled / DELETE) that lands mid-reindex must stop the
 * reindex loop, and must never let it re-open a CodeIndex into the just-disabled
 * project's DB.
 *
 * Two holes are covered here:
 *
 *  1. dropProject bumped the generation only on the path where it actually CLOSED
 *     the connection. When an op was in flight it deferred (correctly — closing
 *     would race the op) and returned BEFORE bumping, so the reindex loop was never
 *     signalled and ran to completion against the project the user had just
 *     disabled. The generation now bumps unconditionally: "stop reindexing" is true
 *     whether or not the close can happen yet.
 *
 *  2. The loop's between-directories generation check runs OUTSIDE the per-project
 *     lock, so it cannot see a drop that lands after a directory has already been
 *     enqueued. withEngine re-checks under the lock, which is authoritative.
 *
 * The codemogger engine and the embedder are stubbed, so this is a fast unit test —
 * no ONNX model load, no real index. The real path is covered live in
 * tests/live-sessions/codemogger-reindex-watch.spec.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const h = vi.hoisted(() => {
  const indexed: string[] = [];
  /** dir -> a gate the fake index() awaits, so a test can hold an op in flight. */
  const gates = new Map<string, Promise<void>>();
  const opened: FakeIndex[] = [];

  class FakeIndex {
    closed = false;
    constructor(public opts: { dbPath: string }) { opened.push(this); }
    async index(dir: string) {
      indexed.push(dir);
      const g = gates.get(dir);
      if (g) await g;
      return { files: 1, chunks: 1, skipped: 0, removed: 0 };
    }
    async search() {
      const g = gates.get('__search__');
      if (g) await g;
      return [];
    }
    close() { this.closed = true; }
  }
  return { indexed, gates, opened, FakeIndex };
});

vi.mock('codemogger', () => ({ CodeIndex: h.FakeIndex }));
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async () => ({ tolist: () => [[0]] }),
}));

const { reindexProject, dropProject, searchProject, hasOpenEngine } =
  await import('../../lib/codemoggerServer');

/** A promise plus its resolver, for holding an op in flight. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(r => { open = r; });
  return { promise, open };
}

/** Let the microtask queue drain so queued lock ops actually start. */
const settle = () => new Promise(r => setTimeout(r, 0));

const tmpDirs: string[] = [];
async function project(): Promise<{ path: string; db: string }> {
  const path = await mkdtemp(join(tmpdir(), 'fury-f10-'));
  tmpDirs.push(path);
  return { path, db: join(path, '.codemogger', 'index.db') };
}

afterEach(async () => {
  h.indexed.length = 0;
  h.gates.clear();
  h.opened.length = 0;
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('drop mid-reindex', () => {
  it('a DEFERRED drop still stops the loop (hole 1 + hole 2)', async () => {
    const { path, db } = await project();

    // d1 hangs, so the reindex has an op in flight.
    const d1 = gate();
    h.gates.set('d1', d1.promise);
    // A second op parked behind d1, so the drop is guaranteed to find inFlight > 0
    // and take the DEFERRED branch — the branch that used to skip the bump.
    const searchGate = gate();
    h.gates.set('__search__', searchGate.promise);

    const reindexing = reindexProject(path, db, ['d1', 'd2', 'd3']);
    await settle();                     // d1 is in flight
    const searching = searchProject(path, db, 'q').catch(() => []);
    const dropping = dropProject(path); // queued behind the search

    d1.open();                          // d1 finishes; the loop enqueues d2
    await settle();
    searchGate.open();                  // search finishes; the drop body now runs
    await Promise.all([reindexing, searching, dropping]);

    // d2 was already enqueued when the drop landed, so the loop's between-dirs
    // check could not catch it — only the under-lock re-check can.
    expect(h.indexed).toEqual(['d1']);
  });

  it('a drop between directories stops the loop (the fast path)', async () => {
    const { path, db } = await project();
    const d1 = gate();
    h.gates.set('d1', d1.promise);

    const reindexing = reindexProject(path, db, ['d1', 'd2', 'd3']);
    await settle();
    const dropping = dropProject(path);
    d1.open();
    await Promise.all([reindexing, dropping]);

    expect(h.indexed).toEqual(['d1']);
  });

  it('never opens a SECOND engine into a dropped project', async () => {
    const { path, db } = await project();
    const d1 = gate();
    h.gates.set('d1', d1.promise);

    const reindexing = reindexProject(path, db, ['d1', 'd2', 'd3']);
    await settle();
    const dropping = dropProject(path);
    d1.open();
    await Promise.all([reindexing, dropping]);

    // One engine for the whole run; the aborted directories never re-opened one.
    expect(h.opened.length).toBe(1);
    expect(hasOpenEngine(path)).toBe(false);
  });

  it('an undisturbed reindex still indexes every directory', async () => {
    const { path, db } = await project();
    await reindexProject(path, db, ['a', 'b', 'c']);
    expect(h.indexed).toEqual(['a', 'b', 'c']);
  });

  it('a reindex started AFTER a drop runs normally (generation is re-captured)', async () => {
    const { path, db } = await project();
    await reindexProject(path, db, ['a']);
    await dropProject(path);
    h.indexed.length = 0;

    // Re-enabling code search must not be poisoned by the earlier bump.
    await reindexProject(path, db, ['a', 'b']);
    expect(h.indexed).toEqual(['a', 'b']);
  });

  it('search is not gated by the generation (it re-opens after a drop)', async () => {
    const { path, db } = await project();
    await reindexProject(path, db, ['a']);
    await dropProject(path);
    // A search has no expectGeneration — getOrCreate simply re-opens the engine.
    await expect(searchProject(path, db, 'q')).resolves.toEqual([]);
    expect(hasOpenEngine(path)).toBe(true);
    await dropProject(path);
  });
});
