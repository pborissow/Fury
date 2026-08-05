/**
 * Data-layer guards for delete → archive (docs/delete-to-archive.md).
 *
 * Runs the REAL initDb migration and the REAL archiveTranscript against a
 * throwaway database: homedir() is mocked to a temp dir, so lib/db's
 * getDbPath() resolves there and getDb() builds a fresh schema we can hammer.
 * Nothing here can touch ~/.claude/fury.db. (getDb's fire-and-forget startup
 * scan finds no <temp>/.claude/projects dir and returns immediately.)
 *
 * Covers the two silent failures — the ones that pass a naive "click archive,
 * it disappears" check and only surface on the next refresh or archive tick:
 *   trap #1: loadArchivedSessions must default to active-only.
 *   trap #2: archiveTranscript's ON CONFLICT must never write status.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'fury-archive-test-'));
mkdirSync(join(TEMP_HOME, '.claude'), { recursive: true });

// Must be mocked before lib/db is imported — getDbPath() reads homedir() at call
// time, but the import graph is hoisted, so do it at module scope.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEMP_HOME };
});

const SESSION = 'archive-status-test-session';
const PROJECT = '/tmp/fury-archive-status-test';
const TS = '2026-07-16T12:00:00.000Z';

const messages = [
  { role: 'user' as const, content: 'hello', timestamp: TS },
  { role: 'assistant' as const, content: 'hi', timestamp: TS },
];
const jsonl = messages.map(m => JSON.stringify({ type: m.role, message: m })).join('\n');

async function statusOf(sessionId: string): Promise<string | null> {
  const { getDb } = await import('../../lib/db');
  const db = await getDb();
  const r = await db.execute({
    sql: 'SELECT status FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
  return r.rows.length ? (r.rows[0].status as string) : null;
}

/** Archive the fixture through the real UPSERT — the path a reactive
 *  re-archive, startup scan, or transcript GET would take. */
async function archive(): Promise<void> {
  const { archiveTranscript } = await import('../../lib/transcriptArchiver');
  await archiveTranscript(
    SESSION, PROJECT, 'hello', jsonl, messages, jsonl.split('\n'), true,
    { usageEvents: [], numCompactions: 0, totalOutputTokens: 0, contextTokens: 100 },
  );
}

describe('session status (delete → archive)', () => {
  beforeAll(async () => {
    await archive();
  });

  afterAll(async () => {
    // Close first: Windows refuses to unlink the still-open DB file (EPERM).
    try {
      const { getDb } = await import('../../lib/db');
      (await getDb()).close();
    } catch { /* never fail the suite on cleanup */ }
    try {
      rmSync(TEMP_HOME, { recursive: true, force: true });
    } catch { /* a leaked temp dir is the OS's problem, not a test failure */ }
  });

  it('a fresh DB has the status column, defaulting to active', async () => {
    // Fresh-DB path: the column comes from CREATE TABLE, not the ALTER.
    expect(await statusOf(SESSION)).toBe('active');
  });

  it('the migration and index are idempotent', async () => {
    // initDb runs once per client; re-running it must not throw (the server
    // restarts constantly, and a throwing ALTER/CREATE INDEX would take the
    // whole DB down on the second boot).
    const { getDb } = await import('../../lib/db');
    const db = await getDb();
    await expect(
      db.execute("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    ).rejects.toThrow(); // proves the guarded try/catch in initDb is load-bearing
    await db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
    expect(await statusOf(SESSION)).toBe('active');
  });

  it('setSessionStatus archives without deleting the row or its children', async () => {
    const { setSessionStatus } = await import('../../lib/transcriptArchiver');
    const { getDb } = await import('../../lib/db');
    const db = await getDb();

    const before = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?',
      args: [SESSION],
    });

    await setSessionStatus(SESSION, 'archived');

    expect(await statusOf(SESSION)).toBe('archived');
    const after = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?',
      args: [SESSION],
    });
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    expect(Number(after.rows[0].n)).toBeGreaterThan(0);
  });

  it('hides archived sessions from the sidebar query, but not from includeArchived (trap #1)', async () => {
    const { loadArchivedSessions } = await import('../../lib/transcriptArchiver');

    const active = await loadArchivedSessions();
    expect(active.map(s => s.session_id)).not.toContain(SESSION);

    const all = await loadArchivedSessions({ includeArchived: true });
    expect(all.map(s => s.session_id)).toContain(SESSION);

    // The project filter must compose with the status filter (WHERE vs AND).
    const scoped = await loadArchivedSessions({ project: PROJECT });
    expect(scoped.map(s => s.session_id)).not.toContain(SESSION);
    const scopedAll = await loadArchivedSessions({ project: PROJECT, includeArchived: true });
    expect(scopedAll.map(s => s.session_id)).toContain(SESSION);
  });

  it('re-archiving an archived session does NOT resurrect it (trap #2)', async () => {
    expect(await statusOf(SESSION)).toBe('archived');

    // The exact ON CONFLICT path a reactive re-archive hits. If `status` is ever
    // added to archiveTranscript's DO UPDATE set-list, this flips back to
    // 'active' and the session silently returns to the sidebar.
    await archive();

    expect(await statusOf(SESSION)).toBe('archived');

    const { loadArchivedSessions } = await import('../../lib/transcriptArchiver');
    const active = await loadArchivedSessions();
    expect(active.map(s => s.session_id)).not.toContain(SESSION);
  });

  it('setSessionStatus is idempotent and no-ops on an unknown session', async () => {
    const { setSessionStatus } = await import('../../lib/transcriptArchiver');

    await setSessionStatus(SESSION, 'archived');
    await setSessionStatus(SESSION, 'archived');
    expect(await statusOf(SESSION)).toBe('archived');

    // A session deleted before its first archive has no row. Updating 0 rows is
    // correct — there's no accounting to preserve and we don't write a tombstone.
    await expect(setSessionStatus('no-such-session-at-all', 'archived')).resolves.toBeUndefined();
    expect(await statusOf('no-such-session-at-all')).toBeNull();
  });

  it('a legacy row created before the migration reads as active', async () => {
    const { getDb } = await import('../../lib/db');
    const { loadArchivedSessions } = await import('../../lib/transcriptArchiver');
    const db = await getDb();

    // Simulate a pre-migration row: insert without naming status at all, exactly
    // as the old code did. The column default is what backfills it.
    const legacy = 'legacy-pre-migration-row';
    await db.execute({
      sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at)
            VALUES (?, ?, ?, 1, 1, 1)`,
      args: [legacy, PROJECT, 'legacy session'],
    });

    expect(await statusOf(legacy)).toBe('active');
    const active = await loadArchivedSessions();
    expect(active.map(s => s.session_id)).toContain(legacy);
  });
});
