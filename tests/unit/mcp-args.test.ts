/**
 * B1 + B3 (docs/ticket-local-mcp-this-project-fails-first-use.md):
 *  - normalizeArgs keeps an array intact (spaced --db paths survive) and only
 *    whitespace-splits a string (the free-form stdio field).
 *  - ensureDbParentDir creates the parent dir of an explicit --db path so
 *    codemogger doesn't crash opening a DB under a non-existent ~/.codemogger.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { normalizeArgs, dbPathFromArgs, ensureDbParentDir } from '../../lib/mcpArgs';

const madeDirs: string[] = [];
afterEach(async () => {
  for (const d of madeDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('normalizeArgs (B3)', () => {
  it('keeps an array intact — a spaced --db path stays one entry', () => {
    const argv = normalizeArgs(['--db', 'C:/Program Files/Git/.codemogger/index.db', 'mcp']);
    expect(argv).toEqual(['--db', 'C:/Program Files/Git/.codemogger/index.db', 'mcp']);
    expect(dbPathFromArgs(argv)).toBe('C:/Program Files/Git/.codemogger/index.db');
  });

  it('splits a string on whitespace (free-form field)', () => {
    expect(normalizeArgs('--db /home/u/.codemogger/index.db mcp'))
      .toEqual(['--db', '/home/u/.codemogger/index.db', 'mcp']);
  });

  it('the OLD string path shatters a spaced path (regression guard for why array matters)', () => {
    // This is exactly the pre-fix bug: a joined string with a spaced path.
    const shattered = normalizeArgs('--db C:/Program Files/Git/.codemogger/index.db mcp');
    expect(shattered).toEqual(['--db', 'C:/Program', 'Files/Git/.codemogger/index.db', 'mcp']);
    // The array form (what the wizard now sends) does NOT shatter:
    expect(dbPathFromArgs(shattered)).toBe('C:/Program'); // broken
    expect(dbPathFromArgs(['--db', 'C:/Program Files/Git/.codemogger/index.db', 'mcp']))
      .toBe('C:/Program Files/Git/.codemogger/index.db'); // intact
  });

  it('handles empty / non-string / non-array', () => {
    expect(normalizeArgs(undefined)).toEqual([]);
    expect(normalizeArgs('')).toEqual([]);
    expect(normalizeArgs(null)).toEqual([]);
    expect(dbPathFromArgs(['mcp'])).toBeNull();
    expect(dbPathFromArgs(['--db'])).toBeNull(); // flag with no value
  });
});

describe('ensureDbParentDir (B1)', () => {
  it('creates a non-existent --db parent directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fury-mcp-b1-'));
    madeDirs.push(base);
    const dbPath = join(base, '.codemogger', 'index.db');
    // Parent does not exist yet.
    await expect(stat(join(base, '.codemogger'))).rejects.toThrow();

    const ensured = await ensureDbParentDir(['--db', dbPath, 'mcp']);
    expect(ensured).toBe(join(base, '.codemogger'));
    const st = await stat(join(base, '.codemogger'));
    expect(st.isDirectory()).toBe(true);
  });

  it('is a no-op when there is no --db arg', async () => {
    expect(await ensureDbParentDir(['mcp'])).toBeNull();
    expect(await ensureDbParentDir([])).toBeNull();
  });
});
