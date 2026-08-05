/**
 * Atomic writes + corrupt-state recovery.
 *
 * Observed failure: `.claude-ui-state/state.json` ended up as a complete 217-byte
 * JSON document with the 30-byte tail of a LONGER previous document glued on,
 * so `JSON.parse` threw "Unexpected non-whitespace character after JSON at
 * position 217". Two servers sharing a `process.cwd()` had both called
 * `fs.writeFile`: both truncate at open, then the shorter payload overwrites only
 * the first N bytes of the longer one and leaves its tail behind.
 *
 * Two independent defects, covered separately below:
 *   - the write was not atomic (cause)
 *   - loadState RETHREW on a parse failure, and saveState calls loadState first,
 *     so one bad byte wedged both endpoints at 500 permanently (blast radius)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWriteFile, atomicWriteFileSync } from '../../lib/atomicWrite';

const tmpDirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'fury-atomic-'));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('writes the file and leaves no temp behind', async () => {
    const dir = await scratch();
    const f = join(dir, 'a.json');
    await atomicWriteFile(f, '{"a":1}');
    expect(JSON.parse(await readFile(f, 'utf-8'))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('replaces a LONGER file with no tail left over (the actual corruption)', async () => {
    const dir = await scratch();
    const f = join(dir, 'state.json');
    const long = JSON.stringify({ a: 1, b: 2, c: 3, extra: 'a legacy field' }, null, 2);
    const short = JSON.stringify({ a: 1 }, null, 2);

    await atomicWriteFile(f, long);
    await atomicWriteFile(f, short);

    const raw = await readFile(f, 'utf-8');
    expect(raw).toBe(short);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('concurrent writers each leave a COMPLETE document, never a splice', async () => {
    const dir = await scratch();
    const f = join(dir, 'state.json');
    // Payloads of very different lengths — the shape that produced the tail.
    const payloads = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ i, pad: 'x'.repeat(i * 40) }, null, 2));

    await Promise.all(payloads.map(p => atomicWriteFile(f, p)));

    const raw = await readFile(f, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    // The winner must be one of the payloads EXACTLY — not a blend of two.
    expect(payloads).toContain(raw);
    expect(readdirSync(dir)).toEqual(['state.json']); // no orphaned temps
  });

  it('cleans up the temp file when the rename fails for good', async () => {
    const dir = await scratch();
    const f = join(dir, 'nope', 'a.json'); // parent does not exist → ENOENT on rename
    await expect(atomicWriteFile(f, 'x')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('sync twin behaves the same', async () => {
    const dir = await scratch();
    const f = join(dir, 'b.json');
    atomicWriteFileSync(f, '{"long":"aaaaaaaaaaaaaaaaaaaa"}');
    atomicWriteFileSync(f, '{"s":1}');
    expect(readFileSync(f, 'utf-8')).toBe('{"s":1}');
    expect(readdirSync(dir)).toEqual(['b.json']);
  });
});

describe('uiStatePersistence corrupt-state recovery', () => {
  /** Point the singleton at a scratch dir (stateFile is private). */
  async function persister() {
    const dir = await scratch();
    const { uiStatePersistence } = await import('../../lib/uiStatePersistence');
    const file = join(dir, '.claude-ui-state', 'state.json');
    await mkdir(join(dir, '.claude-ui-state'), { recursive: true });
    (uiStatePersistence as unknown as { stateFile: string }).stateFile = file;
    return { p: uiStatePersistence, file };
  }

  /** The exact byte pattern seen in the wild: valid doc + tail of a longer one. */
  const SPLICED =
    JSON.stringify({ activeWorkflowId: null, lastUpdated: 1785780651923 }, null, 2) +
    '\n  "lastUpdated": 1785780651923\n}';

  it('reproduces the reported parse error', () => {
    expect(() => JSON.parse(SPLICED))
      .toThrow(/Unexpected non-whitespace character after JSON/);
  });

  it('recovers a spliced file instead of throwing', async () => {
    const { p, file } = await persister();
    await writeFile(file, SPLICED, 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The leading document is intact, so the layout survives rather than
    // resetting — shared recovery with settingsPersistence (lib/corruptState).
    const state = await p.loadState();
    expect(state?.lastUpdated).toBe(1785780651923);
  });

  it('returns null when nothing can be salvaged', async () => {
    const { p, file } = await persister();
    await writeFile(file, '{"chatVerticalLayout": [70, TRUNCATED', 'utf-8');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(p.loadState()).resolves.toBeNull();
  });

  it('SAVE still works after corruption — the wedge is gone', async () => {
    // The severity of the old behaviour: saveState calls loadState first, so a
    // rethrow made every future save fail too. The file could never self-heal.
    const { p, file } = await persister();
    await writeFile(file, SPLICED, 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await p.saveState({ chatVerticalLayout: [70, 30] });

    const state = await p.loadState();
    expect(state?.chatVerticalLayout).toEqual([70, 30]);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('quarantines the bad bytes and repairs the file', async () => {
    const { p, file } = await persister();
    await writeFile(file, SPLICED, 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await p.loadState();
    // Original preserved for diagnosis...
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(SPLICED);
    // ...and the live file is left parseable, not deleted — otherwise the next
    // load would see ENOENT and the recovered state would be lost anyway.
    expect(existsSync(file)).toBe(true);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('rejects JSON that parses but is not an object', async () => {
    const { p, file } = await persister();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['"a string"', '[1,2,3]', 'null', '42']) {
      await writeFile(file, bad, 'utf-8');
      await expect(p.loadState()).resolves.toBeNull();
    }
  });

  it('a missing file is still just null, not an error', async () => {
    const { p } = await persister();
    await expect(p.loadState()).resolves.toBeNull();
  });

  it('round-trips valid state untouched', async () => {
    const { p } = await persister();
    await p.saveState({ chatHorizontalLayout: [20, 45, 35] });
    const state = await p.loadState();
    expect(state?.chatHorizontalLayout).toEqual([20, 45, 35]);
  });
});
