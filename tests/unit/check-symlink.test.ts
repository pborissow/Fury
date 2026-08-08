/**
 * Startup guard: assertRealCwd (lib/checkSymlink.ts).
 *
 * Was scripts/check-symlink.js run as a predev/prestart hook; moved into the
 * server.ts startup path so nothing in scripts/ is required to run the app.
 * These tests pin the three behaviours the pre-hook had:
 *   - no-op when cwd is real (the common case — must not block dev/start),
 *   - abort with guidance when cwd is a symlink/junction,
 *   - never block startup if realpathSync itself fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// checkSymlink imports realpathSync from 'node:fs' at module load, so mock it
// before importing the module under test.
const realpath = vi.fn<(p: string) => string>();
vi.mock('node:fs', () => ({ realpathSync: (p: string) => realpath(p) }));

const { assertRealCwd } = await import('../../lib/checkSymlink');

describe('assertRealCwd', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // process.exit throws so we can assert it fired AND halt the function.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); realpath.mockReset(); });

  it('is a no-op when realpath matches cwd (does not block startup)', () => {
    realpath.mockReturnValue(process.cwd());
    expect(() => assertRealCwd()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('aborts with exit 1 and guidance when cwd is a symlink/junction', () => {
    realpath.mockReturnValue(process.cwd() + '__realpath');
    expect(() => assertRealCwd()).toThrow('exit:1');
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain('Symlink/junction path mismatch');
  });

  it('does not block startup if realpathSync throws (unusual mounts)', () => {
    realpath.mockImplementation(() => { throw new Error('EACCES'); });
    expect(() => assertRealCwd()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

