/**
 * The migration's cross-device (EXDEV) fallback: when rename() fails because
 * source and destination sit on different filesystems, each file must be moved
 * via copy → verify(size) → delete instead, and the source must survive when
 * verification fails.
 *
 * Separate file from fury-home-migration.test.ts because the fs mock has to be
 * module-wide: renameSync always throws EXDEV here.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';

let mockHome = '';
let mockCwd = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mockHome };
});

// Every rename crosses a device boundary in this world.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: () => {
      const err: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    },
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { migrateFuryHome } from '../../lib/furyHomeMigration';

const fury = (...p: string[]) => join(mockHome, '.fury', ...p);

let cwdSpy: ReturnType<typeof vi.spyOn>;
const scratch: string[] = [];

beforeEach(() => {
  mockHome = mkdtempSync(join(tmpdir(), 'fury-exdev-home-'));
  mockCwd = mkdtempSync(join(tmpdir(), 'fury-exdev-cwd-'));
  scratch.push(mockHome, mockCwd);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  delete process.env.FURY_HOME;
  delete process.env.FURY_DB_PATH;
  delete process.env.FURY_IMAGES_PATH;
});

afterAll(() => {
  cwdSpy?.mockRestore();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('migrateFuryHome under EXDEV', () => {
  it('falls back to copy-verify-delete and still completes cleanly', () => {
    const claude = join(mockHome, '.claude');
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, 'fury.db'), 'db-bytes');
    mkdirSync(join(claude, 'fury-images', 'sess-1'), { recursive: true });
    writeFileSync(join(claude, 'fury-images', 'sess-1', 'abc.png'), 'png-bytes');
    writeFileSync(join(claude, 'provider-fallback-log.jsonl'), 'log-line\n');

    const result = migrateFuryHome();

    expect(result.failed).toEqual([]);
    expect(readFileSync(fury('fury.db'), 'utf8')).toBe('db-bytes');
    expect(readFileSync(fury('images', 'sess-1', 'abc.png'), 'utf8')).toBe('png-bytes');
    expect(readFileSync(fury('provider-fallback-log.jsonl'), 'utf8')).toBe('log-line\n');
    expect(existsSync(fury('.migrated'))).toBe(true);

    // Sources deleted only after the verified copy.
    expect(existsSync(join(claude, 'fury.db'))).toBe(false);
    expect(existsSync(join(claude, 'fury-images'))).toBe(false);
    expect(existsSync(join(claude, 'provider-fallback-log.jsonl'))).toBe(false);
  });
});
