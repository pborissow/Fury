import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isBenignClientAbort, installProcessGuards, importWithoutProcessHandlers } from '@/lib/processGuards';

/**
 * Regression coverage for docs/ticket-server-crash-on-aborted-request.md:
 * one aborted client request killed the whole server process.
 */

const GUARDED = ['uncaughtException', 'unhandledRejection'] as const;

/** Restore the test process's own handlers — these tests mutate them. */
function snapshotListeners() {
  const emitter = process as NodeJS.EventEmitter;
  const before = GUARDED.map(ev => [ev, emitter.listeners(ev)] as const);
  return () => {
    for (const [ev, listeners] of before) {
      emitter.removeAllListeners(ev);
      for (const l of listeners) emitter.on(ev, l as (...args: unknown[]) => void);
    }
  };
}

describe('isBenignClientAbort', () => {
  it('recognizes socket-level disconnects', () => {
    expect(isBenignClientAbort(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isBenignClientAbort(Object.assign(new Error('x'), { code: 'ECONNABORTED' }))).toBe(true);
    expect(isBenignClientAbort(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true);
  });

  it('recognizes the exact error that crashed the server', () => {
    // Node emits this on IncomingMessage when a streaming client goes away.
    expect(isBenignClientAbort(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))).toBe(true);
    // ...and the message alone is enough, even without a code.
    expect(isBenignClientAbort(new Error('aborted'))).toBe(true);
  });

  it('recognizes AbortError by name', () => {
    const err = new Error('The operation was cancelled');
    err.name = 'AbortError';
    expect(isBenignClientAbort(err)).toBe(true);
  });

  it('does not swallow real failures', () => {
    expect(isBenignClientAbort(new TypeError('x is not a function'))).toBe(false);
    expect(isBenignClientAbort(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false);
    expect(isBenignClientAbort(null)).toBe(false);
    expect(isBenignClientAbort('aborted')).toBe(false);
  });
});

describe('installProcessGuards', () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  it('registers one handler per guarded event and is idempotent', () => {
    restore = snapshotListeners();
    const counts = GUARDED.map(ev => process.listenerCount(ev));
    installProcessGuards();
    installProcessGuards();
    installProcessGuards();
    GUARDED.forEach((ev, i) => {
      // At most one added — the module-level `installed` flag makes repeats
      // no-ops. (0 if a prior test in this file already installed them.)
      expect(process.listenerCount(ev) - counts[i]).toBeLessThanOrEqual(1);
      expect(process.listenerCount(ev)).toBeGreaterThan(0);
    });
  });
});

describe('importWithoutProcessHandlers', () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  it('strips handlers a module registers while loading', async () => {
    restore = snapshotListeners();
    const before = GUARDED.map(ev => process.listenerCount(ev));

    // Stand-in for phonemizer: rethrows anything that is not its own error.
    const rethrow = (err: unknown) => { throw err; };
    const result = await importWithoutProcessHandlers('fake-phonemizer', async () => {
      process.on('uncaughtException', rethrow);
      process.on('unhandledRejection', rethrow);
      return { loaded: true };
    });

    expect(result).toEqual({ loaded: true });
    GUARDED.forEach((ev, i) => expect(process.listenerCount(ev)).toBe(before[i]));
    expect(process.listeners('uncaughtException')).not.toContain(rethrow);
  });

  it('leaves pre-existing handlers alone', async () => {
    restore = snapshotListeners();
    const ours = () => {};
    process.on('uncaughtException', ours);

    await importWithoutProcessHandlers('noop', async () => 1);

    expect(process.listeners('uncaughtException')).toContain(ours);
  });

  it('still strips when the module load throws', async () => {
    restore = snapshotListeners();
    const before = process.listenerCount('uncaughtException');
    const rethrow = (err: unknown) => { throw err; };

    await expect(importWithoutProcessHandlers('half-loaded', async () => {
      process.on('uncaughtException', rethrow);
      throw new Error('module blew up mid-eval');
    })).rejects.toThrow('module blew up mid-eval');

    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});

describe('lib/tts module graph', () => {
  const src = readFileSync(join(process.cwd(), 'lib', 'tts.ts'), 'utf-8');

  it('never imports kokoro-js statically', () => {
    // A value import here is reachable from app/api/settings/route.ts, which
    // every page load hits — that is what armed phonemizer's fatal handler at
    // startup. A type-only import is erased at compile time and is fine.
    const staticValueImport = /^import\s+(?!type\b)[^;]*?from\s*['"]kokoro-js['"]/m;
    expect(src).not.toMatch(staticValueImport);
  });

  it('loads kokoro-js through the process-handler quarantine', () => {
    expect(src).toMatch(/importWithoutProcessHandlers\(\s*'kokoro-js'/);
  });
});
