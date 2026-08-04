/**
 * F1 (docs/ticket-sdk-pivot-premerge-review.md): the delete route must ARCHIVE a
 * session to SQLite before it unlinks the JSONL, so a session with no prior DB row
 * (deleted inside the fire-and-forget startup-archive window) doesn't lose its only
 * copy. `archiveForDelete` is that guard: it persists the row + usage from disk and
 * returns whether a durable copy now exists — the route unlinks ONLY when true.
 *
 * Runs the REAL initDb + archive path against a throwaway DB via a mocked homedir
 * (same pattern as archive-status.test.ts), and writes real JSONL fixtures under the
 * temp ~/.claude/projects/<slug>/ so archiveForDelete reads them off disk.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'fury-archive-del-'));
mkdirSync(join(TEMP_HOME, '.claude'), { recursive: true });

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEMP_HOME };
});

const PROJECT = '/tmp/fury-archive-del-project';
const TS = '2026-08-04T12:00:00.000Z';

/** Write a session's JSONL under the mocked ~/.claude/projects/<slug>/. */
async function writeJsonl(sessionId: string, lines: string[]): Promise<void> {
  const { projectPathToSlug } = await import('../../lib/utils');
  const dir = join(TEMP_HOME, '.claude', 'projects', projectPathToSlug(PROJECT));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function convo(): string[] {
  // Real Claude JSONL puts timestamp/uuid at the TOP level of each entry (the
  // archiver reads entry.timestamp/entry.uuid, not message.*).
  return [
    JSON.stringify({ type: 'user', timestamp: TS, uuid: 'u-1', message: { role: 'user', content: 'hello there' } }),
    JSON.stringify({ type: 'assistant', timestamp: TS, uuid: 'a-1', message: { role: 'assistant', content: 'hi' } }),
  ];
}

async function statusOf(sessionId: string): Promise<string | null> {
  const { getDb } = await import('../../lib/db');
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT status FROM sessions WHERE session_id = ?', args: [sessionId] });
  return r.rows.length ? (r.rows[0].status as string) : null;
}

describe('archiveForDelete (F1: archive before unlink)', () => {
  afterAll(async () => {
    try { const { getDb } = await import('../../lib/db'); (await getDb()).close(); } catch { /* ignore */ }
    try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('archives a session that has NO prior DB row, then reports it durable', async () => {
    const SID = 'no-row-session';
    await writeJsonl(SID, convo());
    const { archiveForDelete } = await import('../../lib/transcriptArchiver');

    expect(await statusOf(SID), 'no row before').toBeNull();

    // The core F1 fix: even with no prior row, archiving from disk creates one.
    const durable = await archiveForDelete(SID, PROJECT);
    expect(durable, 'a durable copy now exists → route may unlink').toBe(true);
    expect(await statusOf(SID), 'flipped to archived').toBe('archived');

    // Usage/messages were persisted (Stats keeps counting it).
    const { getDb } = await import('../../lib/db');
    const db = await getDb();
    const msgs = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', args: [SID] });
    expect(Number(msgs.rows[0].n), 'messages archived').toBeGreaterThan(0);
  });

  it('returns FALSE (do not unlink) when there is nothing durable to preserve', async () => {
    const { archiveForDelete } = await import('../../lib/transcriptArchiver');
    // No project → cannot locate/archive the JSONL → no row → route keeps the file.
    expect(await archiveForDelete('never-archived', null)).toBe(false);
    expect(await statusOf('never-archived')).toBeNull();
    // Project given but JSONL empty → nothing to archive → still false.
    await writeJsonl('empty-session', ['']);
    expect(await archiveForDelete('empty-session', PROJECT)).toBe(false);
    expect(await statusOf('empty-session')).toBeNull();
  });

  it('reports durable=true for an already-archived session (idempotent re-delete)', async () => {
    const SID = 'already-archived';
    await writeJsonl(SID, convo());
    const { archiveForDelete } = await import('../../lib/transcriptArchiver');
    expect(await archiveForDelete(SID, PROJECT)).toBe(true);
    // Second call: archiveSessionFromDisk hash-skips, but the row still exists.
    expect(await archiveForDelete(SID, PROJECT)).toBe(true);
    expect(await statusOf(SID)).toBe('archived');
  });

  it('F1b: a reactive re-archive after delete does NOT resurrect it as active', async () => {
    const SID = 'no-resurrect';
    const lines = convo();
    await writeJsonl(SID, lines);
    const { archiveForDelete, archiveTranscript } = await import('../../lib/transcriptArchiver');

    expect(await archiveForDelete(SID, PROJECT)).toBe(true);
    expect(await statusOf(SID)).toBe('archived');

    // Simulate the reactive listener firing on the still-present JSONL between the
    // status flip and the unlink — the exact ON CONFLICT path. Status must stay put.
    await archiveTranscript(
      SID, PROJECT, 'hello there', lines.join('\n') + '\n',
      [{ role: 'user', content: 'hello there', timestamp: TS }],
      lines, true, { usageEvents: [], numCompactions: 0, totalOutputTokens: 0, contextTokens: 100 },
    );
    expect(await statusOf(SID), 'still archived after reactive re-archive').toBe('archived');
  });
});
