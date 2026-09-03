/**
 * Path-resolver precedence for the Fury home (lib/furyHome.ts):
 *
 *   specific override (FURY_DB_PATH / FURY_IMAGES_PATH)
 *     > FURY_HOME umbrella
 *       > ~/.fury default
 *
 * plus the transitional read-fallback: when the new location is absent but the
 * legacy one exists (failed/skipped migration), resolvers return the legacy
 * path so a partial migration never presents as data loss.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let mockHome = mkdtempSync(join(tmpdir(), 'fury-home-resolver-'));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mockHome };
});

import {
  furyHome,
  furyPath,
  furyDbPath,
  furyImagesRoot,
  furySettingsFile,
  furyUiStateFile,
} from '../../lib/furyHome';

const SAVED_ENV = { ...process.env };
function resetEnv(): void {
  for (const k of ['FURY_HOME', 'FURY_DB_PATH', 'FURY_IMAGES_PATH']) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

beforeEach(() => {
  rmSync(mockHome, { recursive: true, force: true });
  mockHome = mkdtempSync(join(tmpdir(), 'fury-home-resolver-'));
  delete process.env.FURY_HOME;
  delete process.env.FURY_DB_PATH;
  delete process.env.FURY_IMAGES_PATH;
});

afterAll(() => {
  resetEnv();
  rmSync(mockHome, { recursive: true, force: true });
});

describe('furyHome / furyPath', () => {
  it('defaults to ~/.fury', () => {
    expect(furyHome()).toBe(join(mockHome, '.fury'));
    expect(furyPath('state', 'settings.json'))
      .toBe(join(mockHome, '.fury', 'state', 'settings.json'));
  });

  it('honors the FURY_HOME umbrella', () => {
    process.env.FURY_HOME = '/custom/fury-home';
    expect(furyHome()).toBe('/custom/fury-home');
    expect(furyDbPath()).toBe(join('/custom/fury-home', 'fury.db'));
  });
});

describe('specific overrides beat FURY_HOME', () => {
  it('FURY_DB_PATH wins even when FURY_HOME is set', () => {
    process.env.FURY_HOME = '/custom/fury-home';
    process.env.FURY_DB_PATH = '/scratch/test.db';
    expect(furyDbPath()).toBe('/scratch/test.db');
  });

  it('FURY_IMAGES_PATH wins even when FURY_HOME is set', () => {
    process.env.FURY_HOME = '/custom/fury-home';
    process.env.FURY_IMAGES_PATH = '/scratch/images';
    expect(furyImagesRoot()).toBe('/scratch/images');
  });
});

describe('legacy read-fallback', () => {
  it('resolves the legacy DB when the new location is absent', () => {
    const legacy = join(mockHome, '.claude', 'fury.db');
    mkdirSync(join(mockHome, '.claude'), { recursive: true });
    writeFileSync(legacy, 'db-bytes');
    expect(furyDbPath()).toBe(legacy);
  });

  it('prefers the new location once it exists, even with a legacy leftover', () => {
    mkdirSync(join(mockHome, '.claude'), { recursive: true });
    writeFileSync(join(mockHome, '.claude', 'fury.db'), 'old');
    mkdirSync(join(mockHome, '.fury'), { recursive: true });
    writeFileSync(join(mockHome, '.fury', 'fury.db'), 'new');
    expect(furyDbPath()).toBe(join(mockHome, '.fury', 'fury.db'));
  });

  it('returns the new path when neither location exists (fresh install)', () => {
    expect(furyDbPath()).toBe(join(mockHome, '.fury', 'fury.db'));
    expect(furyImagesRoot()).toBe(join(mockHome, '.fury', 'images'));
  });

  it('falls back to the $cwd ui-state files, honoring the state.json rename', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fury-cwd-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      mkdirSync(join(cwd, '.claude-ui-state'), { recursive: true });
      writeFileSync(join(cwd, '.claude-ui-state', 'settings.json'), '{}');
      writeFileSync(join(cwd, '.claude-ui-state', 'state.json'), '{}');
      expect(furySettingsFile()).toBe(join(cwd, '.claude-ui-state', 'settings.json'));
      // Legacy name is state.json; the new home calls it ui-state.json.
      expect(furyUiStateFile()).toBe(join(cwd, '.claude-ui-state', 'state.json'));
    } finally {
      cwdSpy.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
