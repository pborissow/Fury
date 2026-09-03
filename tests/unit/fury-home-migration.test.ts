/**
 * One-time ~/.fury migration (lib/furyHomeMigration.ts), against a fully faked
 * $HOME and $cwd:
 *
 *  - everything Fury-owned lands under ~/.fury (db + WAL sidecars, images,
 *    logs, provider-fallback-log, notes, settings/ui-state/prompts/workflows)
 *  - originals are gone, the marker is written
 *  - a second run is a no-op (marker guard)
 *  - items with an explicit env override (FURY_DB_PATH) are skipped
 *  - a fresh lock held by another instance skips the run
 *  - interop guard: Claude-Code-owned paths (~/.claude/projects, history.jsonl,
 *    settings.json) are NOT touched
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let mockHome = '';
let mockCwd = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mockHome };
});

import { migrateFuryHome } from '../../lib/furyHomeMigration';

const fury = (...p: string[]) => join(mockHome, '.fury', ...p);

/** Seed the full legacy layout plus the Claude-owned files that must not move. */
function seedLegacyTree(): void {
  const claude = join(mockHome, '.claude');

  // Fury-owned, in ~/.claude
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, 'fury.db'), 'db-bytes');
  writeFileSync(join(claude, 'fury.db-wal'), 'wal-bytes');
  mkdirSync(join(claude, 'fury-images', 'sess-1'), { recursive: true });
  writeFileSync(join(claude, 'fury-images', 'sess-1', 'abc.png'), 'png-bytes');
  mkdirSync(join(claude, 'fury-logs'), { recursive: true });
  writeFileSync(join(claude, 'fury-logs', 'fury-2026-09-01.jsonl'), '{"msg":"hi"}\n');
  writeFileSync(join(claude, 'provider-fallback-log.jsonl'), '{"type":"switched-to-anthropic"}\n');

  // Fury-owned, $HOME sibling
  mkdirSync(join(mockHome, '.claude-session-notes'), { recursive: true });
  writeFileSync(join(mockHome, '.claude-session-notes', 'proj-slug.md'), '# notes');

  // Fury-owned, $cwd
  mkdirSync(join(mockCwd, '.claude-ui-state'), { recursive: true });
  writeFileSync(join(mockCwd, '.claude-ui-state', 'settings.json'), '{"ttsEnabled":true}');
  writeFileSync(join(mockCwd, '.claude-ui-state', 'state.json'), '{"statsRange":"30d"}');
  mkdirSync(join(mockCwd, '.claude-prompts'), { recursive: true });
  writeFileSync(join(mockCwd, '.claude-prompts', 'p1.json'), '{"id":"p1"}');
  mkdirSync(join(mockCwd, '.claude-workflows'), { recursive: true });
  writeFileSync(join(mockCwd, '.claude-workflows', 'w1.json'), '{"id":"w1"}');

  // Claude-Code-owned — MUST stay put
  mkdirSync(join(claude, 'projects', 'some-slug'), { recursive: true });
  writeFileSync(join(claude, 'projects', 'some-slug', 'sess.jsonl'), '{"type":"user"}\n');
  writeFileSync(join(claude, 'history.jsonl'), '{"display":"hi"}\n');
  writeFileSync(join(claude, 'settings.json'), '{"env":{}}');
}

let cwdSpy: ReturnType<typeof vi.spyOn>;
const scratch: string[] = [];

beforeEach(() => {
  mockHome = mkdtempSync(join(tmpdir(), 'fury-mig-home-'));
  mockCwd = mkdtempSync(join(tmpdir(), 'fury-mig-cwd-'));
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

describe('migrateFuryHome', () => {
  it('moves every Fury-owned store under ~/.fury and writes the marker', () => {
    seedLegacyTree();
    const result = migrateFuryHome();

    expect(result.ran).toBe(true);
    expect(result.failed).toEqual([]);

    // Everything landed, contents intact.
    expect(readFileSync(fury('fury.db'), 'utf8')).toBe('db-bytes');
    expect(readFileSync(fury('fury.db-wal'), 'utf8')).toBe('wal-bytes');
    expect(readFileSync(fury('images', 'sess-1', 'abc.png'), 'utf8')).toBe('png-bytes');
    expect(existsSync(fury('logs', 'fury-2026-09-01.jsonl'))).toBe(true);
    expect(existsSync(fury('provider-fallback-log.jsonl'))).toBe(true);
    expect(readFileSync(fury('notes', 'proj-slug.md'), 'utf8')).toBe('# notes');
    expect(readFileSync(fury('state', 'settings.json'), 'utf8')).toBe('{"ttsEnabled":true}');
    // state.json is RENAMED to ui-state.json on the way in.
    expect(readFileSync(fury('state', 'ui-state.json'), 'utf8')).toBe('{"statsRange":"30d"}');
    expect(existsSync(fury('state', 'prompts', 'p1.json'))).toBe(true);
    expect(existsSync(fury('state', 'workflows', 'w1.json'))).toBe(true);
    expect(existsSync(fury('.migrated'))).toBe(true);

    // Originals are gone.
    expect(existsSync(join(mockHome, '.claude', 'fury.db'))).toBe(false);
    expect(existsSync(join(mockHome, '.claude', 'fury-images'))).toBe(false);
    expect(existsSync(join(mockHome, '.claude', 'fury-logs'))).toBe(false);
    expect(existsSync(join(mockHome, '.claude', 'provider-fallback-log.jsonl'))).toBe(false);
    expect(existsSync(join(mockHome, '.claude-session-notes'))).toBe(false);
    expect(existsSync(join(mockCwd, '.claude-ui-state'))).toBe(false);
    expect(existsSync(join(mockCwd, '.claude-prompts'))).toBe(false);
    expect(existsSync(join(mockCwd, '.claude-workflows'))).toBe(false);
  });

  it('interop guard: Claude-Code-owned paths are untouched', () => {
    seedLegacyTree();
    migrateFuryHome();

    const claude = join(mockHome, '.claude');
    expect(readFileSync(join(claude, 'projects', 'some-slug', 'sess.jsonl'), 'utf8'))
      .toBe('{"type":"user"}\n');
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('{"display":"hi"}\n');
    expect(readFileSync(join(claude, 'settings.json'), 'utf8')).toBe('{"env":{}}');
  });

  it('second run is a no-op via the marker', () => {
    seedLegacyTree();
    expect(migrateFuryHome().ran).toBe(true);

    // Recreate a legacy file; the marker must prevent it being re-moved.
    writeFileSync(join(mockHome, '.claude', 'fury.db'), 'stray');
    const second = migrateFuryHome();
    expect(second.ran).toBe(false);
    expect(second.moved).toEqual([]);
    expect(existsSync(join(mockHome, '.claude', 'fury.db'))).toBe(true);
  });

  it('skips the DB when FURY_DB_PATH is set (user chose its home)', () => {
    seedLegacyTree();
    process.env.FURY_DB_PATH = join(mockHome, 'elsewhere.db');
    const result = migrateFuryHome();

    expect(result.failed).toEqual([]);
    // DB stayed put; everything else still moved.
    expect(existsSync(join(mockHome, '.claude', 'fury.db'))).toBe(true);
    expect(existsSync(fury('fury.db'))).toBe(false);
    expect(existsSync(fury('images', 'sess-1', 'abc.png'))).toBe(true);
    expect(existsSync(fury('.migrated'))).toBe(true);
  });

  it('a fresh lock held by another instance skips the run', () => {
    seedLegacyTree();
    mkdirSync(fury('.migrating'), { recursive: true });
    const result = migrateFuryHome();
    expect(result.ran).toBe(false);
    // Nothing moved, no marker — the other instance owns the migration.
    expect(existsSync(join(mockHome, '.claude', 'fury.db'))).toBe(true);
    expect(existsSync(fury('.migrated'))).toBe(false);
  });

  it('merges into an already-existing destination dir without clobbering', () => {
    seedLegacyTree();
    // Simulate the logger having created the new logs dir (with a file) first.
    mkdirSync(fury('logs'), { recursive: true });
    writeFileSync(fury('logs', 'fury-2026-09-02.jsonl'), '{"msg":"new"}\n');

    const result = migrateFuryHome();
    expect(result.failed).toEqual([]);
    // Both the pre-existing new file and the migrated legacy file are present.
    expect(existsSync(fury('logs', 'fury-2026-09-02.jsonl'))).toBe(true);
    expect(existsSync(fury('logs', 'fury-2026-09-01.jsonl'))).toBe(true);
    expect(existsSync(join(mockHome, '.claude', 'fury-logs'))).toBe(false);
  });

  it('fresh install (nothing to move) still writes the marker', () => {
    const result = migrateFuryHome();
    expect(result.ran).toBe(true);
    expect(result.moved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(existsSync(fury('.migrated'))).toBe(true);
  });
});
