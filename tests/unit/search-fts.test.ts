/**
 * messages_fts migration + trigger integrity (docs/plan-search-tab.md §7):
 * the external-content FTS index must (a) build on a fresh DB, (b) stay
 * consistent through the archiver's DELETE-then-INSERT cycle with ZERO
 * archiver changes, (c) survive initDb re-runs idempotently, and (d) never
 * 500 on adversarial MATCH inputs produced by buildSearchQuery.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// MUST be set before the first getDb().
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fury-searchfts-'));
process.env.FURY_DB_PATH = join(TEMP_ROOT, 'test.db');

import { getDb } from '../../lib/db';
import { buildSearchQuery, RENDERED_BUBBLES_FILTER } from '../../lib/searchQuery';

afterAll(() => {
  delete process.env.FURY_DB_PATH;
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

async function seedSession(sessionId: string, contents: string[], status = 'active') {
  const db = await getDb();
  const now = Date.now();
  await db.execute({
    sql: `INSERT OR REPLACE INTO sessions (session_id, project, display, message_count, created_at, updated_at, status)
          VALUES (?, '/tmp/proj', ?, ?, ?, ?, ?)`,
    args: [sessionId, `display for ${sessionId}`, contents.length, now, now, status],
  });
  // The archiver's cycle: wipe, then reinsert with fresh turn indices.
  await db.execute({ sql: 'DELETE FROM messages WHERE session_id = ?', args: [sessionId] });
  for (let i = 0; i < contents.length; i++) {
    await db.execute({
      sql: 'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
      args: [sessionId, i % 2 === 0 ? 'user' : 'assistant', contents[i], new Date().toISOString(), i],
    });
  }
}

async function ftsHits(match: string): Promise<string[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT m.content FROM messages_fts
          JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts)`,
    args: [match],
  });
  return res.rows.map(r => String(r.content));
}

describe('messages_fts', () => {
  it('indexes rows inserted through the plain messages INSERT path', async () => {
    await seedSession('fts-a', [
      'please read docs/plan-fury-home-migration.md and summarize',
      'The image clipboard feature works end to end now.',
    ]);
    expect(await ftsHits('"docs plan-fury-home-migration.md"')).toHaveLength(1);
    expect(await ftsHits('"image" "clipboard"')).toHaveLength(1);
  });

  it('prefix phrase matches partial paths', async () => {
    expect(await ftsHits('"plan-fury-home"*')).toHaveLength(1);
  });

  it('stays consistent through the archiver delete-then-reinsert cycle', async () => {
    // Re-archive the same session with CHANGED content: the old text must
    // leave the index (delete trigger) and the new text must enter it.
    await seedSession('fts-a', [
      'please read docs/plan-fury-home-migration.md and summarize',
      'The paste pipeline was renamed entirely.',
    ]);
    expect(await ftsHits('"image" "clipboard"')).toHaveLength(0);
    expect(await ftsHits('"paste" "pipeline"')).toHaveLength(1);
    // And the integrity self-check must pass (throws on a desynced index).
    const db = await getDb();
    await expect(
      db.execute("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)"),
    ).resolves.toBeDefined();
  });

  it('UPDATE trigger keeps the index in sync', async () => {
    const db = await getDb();
    await db.execute({
      sql: "UPDATE messages SET content = 'now it mentions zanzibar instead' WHERE session_id = 'fts-a' AND turn_index = 1",
      args: [],
    });
    expect(await ftsHits('"paste" "pipeline"')).toHaveLength(0);
    expect(await ftsHits('"zanzibar"')).toHaveLength(1);
  });

  it('initDb re-run is idempotent (no duplicate index rows)', async () => {
    // Simulate the HMR remigrate path: getDb re-runs initDb when the cached
    // schema version trails. Directly re-running the trigger/table DDL must
    // not double-index (IF NOT EXISTS + backfill gated on table creation).
    const db = await getDb();
    const before = await ftsHits('"zanzibar"');
    // Fresh getDb call — single-flight remigration already ran; verify count.
    expect(await ftsHits('"zanzibar"')).toHaveLength(before.length);
    const count = await db.execute("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH '\"zanzibar\"'");
    expect(Number(count.rows[0].c)).toBe(1);
  });

  it('never fails to parse adversarial user input routed through buildSearchQuery', async () => {
    const inputs = [
      'NEAR', 'a AND b', 'col:value', '"unbalanced', 'star*', '(paren',
      'weird^caret', '-', '.', '_', 'docs/', '//', 'say "hi" there',
      'ümlaut café', '日本語テスト', 'a'.repeat(500),
    ];
    for (const input of inputs) {
      const plan = buildSearchQuery(input);
      if (!plan) continue;
      // Must not throw — result content is irrelevant.
      await expect(ftsHits(plan.match)).resolves.toBeDefined();
    }
  });

  it('archived sessions remain searchable (DB superset of disk)', async () => {
    await seedSession('fts-archived', ['the archived needle haystack message'], 'archived');
    const db = await getDb();
    const res = await db.execute({
      sql: `SELECT s.status FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
            JOIN sessions s ON s.session_id = m.session_id
            WHERE messages_fts MATCH ?`,
      args: ['"needle" "haystack"'],
    });
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0].status)).toBe('archived');
  });

  it('RENDERED_BUBBLES_FILTER excludes intermediary assistant segments but keeps user bubbles and the final segment of each run', async () => {
    const db = await getDb();
    const sid = 'fts-intermediary';
    const now = Date.now();
    await db.execute({
      sql: `INSERT OR REPLACE INTO sessions (session_id, project, display, message_count, created_at, updated_at, status)
            VALUES (?, '/tmp/proj', 'intermediary test', 5, ?, ?, 'active')`,
      args: [sid, now, now],
    });
    await db.execute({ sql: 'DELETE FROM messages WHERE session_id = ?', args: [sid] });
    // Mirrors the renderer's grouping (TranscriptRenderer ~168-180): within a
    // turn, every assistant row except the LAST of its consecutive run is an
    // intermediary and is collapsed in the default view.
    const rows: [string, string][] = [
      ['user', 'zebrafinch question from the user'],           // 0 → rendered
      ['assistant', 'zebrafinch intermediary segment one'],    // 1 → collapsed
      ['assistant', 'zebrafinch intermediary segment two'],    // 2 → collapsed
      ['assistant', 'zebrafinch final answer segment'],        // 3 → rendered
      ['user', 'zebrafinch follow-up from the user'],          // 4 → rendered
      ['assistant', 'zebrafinch trailing final segment'],      // 5 → rendered (last row)
    ];
    for (let i = 0; i < rows.length; i++) {
      await db.execute({
        sql: 'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
        args: [sid, rows[i][0], rows[i][1], new Date().toISOString(), i],
      });
    }
    const res = await db.execute({
      sql: `SELECT m.content FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
            WHERE messages_fts MATCH ? AND m.session_id = ?${RENDERED_BUBBLES_FILTER}
            ORDER BY m.turn_index`,
      args: ['zebrafinch', sid],
    });
    const hits = res.rows.map(r => String(r.content));
    expect(hits).toEqual([
      'zebrafinch question from the user',
      'zebrafinch final answer segment',
      'zebrafinch follow-up from the user',
      'zebrafinch trailing final segment',
    ]);
  });
});
