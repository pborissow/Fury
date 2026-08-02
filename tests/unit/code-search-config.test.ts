/**
 * In-process code-search config + legacy stdio migration
 * (docs/ticket-codesearch-inprocess-mcp-macos-contention.md). Pure disk I/O — no
 * embedder, no server. Verifies the `<project>/.codemogger/fury-codesearch.json`
 * read/write/enable/disable lifecycle and the auto-migration off the old stdio
 * `.mcp.json` codemogger registration.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readCodeSearchConfig, writeCodeSearchConfig, removeCodeSearchConfig,
  isCodeSearchEnabled, codeSearchDirs, codeSearchDbPath, codeSearchConfigPath,
  migrateStdioCodemogger, stripStdioCodemogger,
} from '../../lib/codeSearchConfig';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function scratch(): string {
  const p = mkdtempSync(join(tmpdir(), 'fury-cs-'));
  made.push(p);
  return p;
}

describe('config read/write lifecycle', () => {
  it('round-trips selected dirs and flips isCodeSearchEnabled', () => {
    const p = scratch();
    expect(isCodeSearchEnabled(p)).toBe(false);
    expect(readCodeSearchConfig(p)).toBeNull();

    writeCodeSearchConfig(p, [join(p, 'src'), join(p, 'ui')]);
    expect(isCodeSearchEnabled(p)).toBe(true);
    expect(readCodeSearchConfig(p)!.dirs).toEqual([join(p, 'src'), join(p, 'ui')]);
    // Written under .codemogger/fury-codesearch.json.
    expect(existsSync(codeSearchConfigPath(p))).toBe(true);
  });

  it('codeSearchDirs falls back to the project root when dirs is empty', () => {
    const p = scratch();
    writeCodeSearchConfig(p, []);
    expect(codeSearchDirs(p)).toEqual([p]);
  });

  it('codeSearchDirs is [] when disabled; dbPath is under .codemogger', () => {
    const p = scratch();
    expect(codeSearchDirs(p)).toEqual([]);
    expect(codeSearchDbPath(p)).toBe(join(p, '.codemogger', 'index.db'));
  });

  it('removeCodeSearchConfig disables code search', () => {
    const p = scratch();
    writeCodeSearchConfig(p, [p]);
    removeCodeSearchConfig(p);
    expect(isCodeSearchEnabled(p)).toBe(false);
  });

  it('tolerates a malformed config file (treats it as disabled)', () => {
    const p = scratch();
    mkdirSync(join(p, '.codemogger'), { recursive: true });
    writeFileSync(codeSearchConfigPath(p), '{ not json');
    expect(readCodeSearchConfig(p)).toBeNull();
  });
});

describe('stripStdioCodemogger', () => {
  it('removes only codemogger entries (by command), keeping others', () => {
    const p = scratch();
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'my-search': { command: 'codemogger', args: ['--db', 'x', 'mcp'] },
        other: { command: 'some-tool', args: [] },
      },
    }, null, 2));
    const removed = stripStdioCodemogger(p);
    expect(removed).toEqual(['my-search']);
    const cfg = JSON.parse(readFileSync(join(p, '.mcp.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers)).toEqual(['other']);
  });

  it('deletes .mcp.json entirely when codemogger was its only content', () => {
    const p = scratch();
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['mcp'] } },
    }, null, 2));
    expect(stripStdioCodemogger(p)).toEqual(['codemogger']);
    expect(existsSync(join(p, '.mcp.json'))).toBe(false);
  });

  it('is a no-op (returns []) when there is no codemogger entry', () => {
    const p = scratch();
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    expect(stripStdioCodemogger(p)).toEqual([]);
    expect(existsSync(join(p, '.mcp.json'))).toBe(true);
  });
});

describe('migrateStdioCodemogger', () => {
  it('carries the legacy sidecar dirs into the config and strips the stdio entry', () => {
    const p = scratch();
    const db = join(p, '.codemogger', 'index.db');
    mkdirSync(join(p, '.codemogger'), { recursive: true });
    // Legacy per-project selected-dirs sidecar next to the --db.
    writeFileSync(join(p, '.codemogger', '.fury-index-dirs.json'),
      JSON.stringify({ dirs: [join(p, 'src')] }));
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', db, 'mcp'] } },
    }, null, 2));

    expect(migrateStdioCodemogger(p)).toBe(true);
    expect(isCodeSearchEnabled(p)).toBe(true);
    expect(readCodeSearchConfig(p)!.dirs).toEqual([join(p, 'src')]);
    // stdio entry stripped (file removed — codemogger was the only server).
    expect(existsSync(join(p, '.mcp.json'))).toBe(false);
  });

  it('defaults to the project root when no legacy sidecar exists', () => {
    const p = scratch();
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', join(p, '.codemogger', 'index.db'), 'mcp'] } },
    }, null, 2));
    expect(migrateStdioCodemogger(p)).toBe(true);
    expect(readCodeSearchConfig(p)!.dirs).toEqual([p]);
  });

  it('is idempotent and a no-op once migrated / when absent', () => {
    const p = scratch();
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['mcp'] } },
    }));
    expect(migrateStdioCodemogger(p)).toBe(true);
    expect(migrateStdioCodemogger(p)).toBe(false); // nothing left to migrate

    const q = scratch(); // no .mcp.json at all
    expect(migrateStdioCodemogger(q)).toBe(false);
  });

  it('does not clobber an existing in-process config, but still strips the stale stdio entry', () => {
    const p = scratch();
    writeCodeSearchConfig(p, [join(p, 'keep-me')]);
    writeFileSync(join(p, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', join(p, '.codemogger', 'index.db'), 'mcp'] } },
    }));
    expect(migrateStdioCodemogger(p)).toBe(true);
    // Existing dirs preserved (not overwritten by the migration default).
    expect(readCodeSearchConfig(p)!.dirs).toEqual([join(p, 'keep-me')]);
    expect(existsSync(join(p, '.mcp.json'))).toBe(false);
  });
});
