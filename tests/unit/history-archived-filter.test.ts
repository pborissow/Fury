/**
 * /api/history must hide archived sessions no matter which source surfaced them.
 *
 * The subtle half of trap #1. loadArchivedSessions' status filter only governs
 * the DB-merge path; /api/history builds its PRIMARY list from history.jsonl,
 * which carries no status. So the delete route's history-strip — not the DB flag
 * — is what actually hides an archived session, and that strip is best-effort:
 * its failure is caught and logged while the route still reports success, and an
 * external `claude --resume <id>` re-appends a history line regardless. Either
 * way the row stays 'archived' while the sidebar keeps rendering it.
 *
 * These tests seed a real history.jsonl in a temp home and drive the real route,
 * so they exercise the file-sourced path the e2e deliberately can't reach (its
 * fixture is never written to history.jsonl, for safety).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'fury-history-filter-'));
mkdirSync(join(TEMP_HOME, '.claude'), { recursive: true });

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEMP_HOME };
});

const SESSION = 'history-sourced-session';
const PROJECT = '/tmp/fury-history-filter-test';
const DISPLAY = 'a session that still has a history entry';
const TS = Date.now();

interface Entry {
  sessionId?: string;
  display: string;
  project: string;
  metadata?: Record<string, unknown>;
}

async function fetchHistory(): Promise<Entry[]> {
  const { GET } = await import('../../app/api/history/route');
  const res = await GET(new Request('http://localhost:3879/api/history?limit=50') as any);
  const body = await res.json();
  return body.entries as Entry[];
}

describe('/api/history hides archived sessions sourced from history.jsonl', () => {
  beforeAll(async () => {
    // The session exists in history.jsonl (the primary list) AND in the DB.
    // This is the state after a history-strip failure, or after an external
    // `claude --resume` re-appends an entry for an archived session.
    writeFileSync(
      join(TEMP_HOME, '.claude', 'history.jsonl'),
      JSON.stringify({ sessionId: SESSION, display: DISPLAY, project: PROJECT, timestamp: TS }) + '\n',
      'utf-8',
    );

    const { getDb } = await import('../../lib/db');
    const db = await getDb();
    await db.execute({
      sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, metadata, status)
            VALUES (?, ?, ?, 2, ?, ?, ?, 'active')`,
      args: [SESSION, PROJECT, DISPLAY, TS, TS,
             JSON.stringify({ contextTokens: 42_000, contextWindow: 200_000, numCompactions: 1 })],
    });
  });

  afterAll(async () => {
    try {
      const { getDb } = await import('../../lib/db');
      (await getDb()).close();
    } catch { /* cleanup must never fail the suite */ }
    try {
      rmSync(TEMP_HOME, { recursive: true, force: true });
    } catch { /* leaked temp dir is the OS's problem */ }
  });

  it('shows an active session and enriches it with DB metadata', async () => {
    const entries = await fetchHistory();
    const found = entries.find(e => e.sessionId === SESSION);
    expect(found).toBeDefined();
    // Enrichment drives the sidebar's context %, fill meter and compaction icons.
    expect(found!.metadata).toMatchObject({ contextTokens: 42_000, numCompactions: 1 });
  });

  it('hides it once archived, even though its history.jsonl entry survives', async () => {
    const { setSessionStatus } = await import('../../lib/transcriptArchiver');
    await setSessionStatus(SESSION, 'archived');

    const entries = await fetchHistory();
    // The DB flag is the authority — not the presence of a history entry.
    expect(entries.find(e => e.sessionId === SESSION)).toBeUndefined();
  });

  it('keeps unrelated history-sourced sessions visible', async () => {
    // Guards the filter against over-reach: an entry with no DB row at all must
    // still render (that's most of the sidebar on a fresh install).
    writeFileSync(
      join(TEMP_HOME, '.claude', 'history.jsonl'),
      JSON.stringify({ sessionId: SESSION, display: DISPLAY, project: PROJECT, timestamp: TS }) + '\n' +
      JSON.stringify({ sessionId: 'unrelated-session', display: 'still here', project: PROJECT, timestamp: TS + 1 }) + '\n',
      'utf-8',
    );

    const entries = await fetchHistory();
    expect(entries.find(e => e.sessionId === 'unrelated-session')).toBeDefined();
    expect(entries.find(e => e.sessionId === SESSION)).toBeUndefined();
  });
});
