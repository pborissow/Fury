/**
 * Transcript archival layer — persists parsed transcripts to SQLite
 * and retrieves them when the original JSONL files are gone.
 */

import { createHash } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getDb } from './db';
import { eventBus } from './eventBus';
import { parseTranscriptJsonl, type TranscriptMessage } from './transcriptParser';
import { projectPathToSlug } from './utils';

export interface SessionRecord {
  session_id: string;
  project: string;
  display: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a session is already archived with the same JSONL content.
 */
export async function isCurrentlyArchived(
  sessionId: string,
  jsonlHash: string
): Promise<boolean> {
  const db = await getDb();
  const row = await db.execute({
    sql: 'SELECT jsonl_hash FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
  return row.rows.length > 0 && row.rows[0].jsonl_hash === jsonlHash;
}

/**
 * Archive a transcript to SQLite. Skips if the content hash hasn't changed.
 *
 * Uses a transaction: UPSERT the session, then delete + re-insert all
 * messages and raw lines. This handles both new sessions and updates
 * (e.g. after a session grows or is rewound).
 */
export async function archiveTranscript(
  sessionId: string,
  project: string,
  display: string,
  jsonlContent: string,
  messages: TranscriptMessage[],
  rawLines?: string[]
): Promise<void> {
  const hash = computeHash(jsonlContent);

  if (await isCurrentlyArchived(sessionId, hash)) return;

  const db = await getDb();
  const now = Date.now();

  // Determine created_at: keep existing if present, otherwise use earliest message timestamp
  const existing = await db.execute({
    sql: 'SELECT created_at FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
  const createdAt = existing.rows.length > 0
    ? (existing.rows[0].created_at as number)
    : (messages.length > 0
      ? new Date(messages[0].timestamp).getTime() || now
      : now);

  // Build statements: UPSERT session, clear old data, then insert new data
  const preamble = [
    {
      sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, jsonl_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              project = excluded.project,
              display = excluded.display,
              message_count = excluded.message_count,
              updated_at = excluded.updated_at,
              jsonl_hash = excluded.jsonl_hash`,
      args: [sessionId, project, display.substring(0, 200), messages.length, createdAt, now, hash],
    },
    { sql: 'DELETE FROM messages WHERE session_id = ?', args: [sessionId] },
    { sql: 'DELETE FROM raw_jsonl WHERE session_id = ?', args: [sessionId] },
  ];

  const inserts: { sql: string; args: any[] }[] = [];
  for (let i = 0; i < messages.length; i++) {
    inserts.push({
      sql: 'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
      args: [sessionId, messages[i].role, messages[i].content, messages[i].timestamp, i],
    });
  }
  const lines = rawLines ?? jsonlContent.split('\n').filter(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    inserts.push({
      sql: 'INSERT INTO raw_jsonl (session_id, line_number, content) VALUES (?, ?, ?)',
      args: [sessionId, i, lines[i]],
    });
  }

  // Chunk inserts to avoid hitting batch size limits on very large sessions
  const CHUNK_SIZE = 500;
  const firstChunk = inserts.slice(0, CHUNK_SIZE);
  await db.batch([...preamble, ...firstChunk], 'write');

  for (let offset = CHUNK_SIZE; offset < inserts.length; offset += CHUNK_SIZE) {
    await db.batch(inserts.slice(offset, offset + CHUNK_SIZE), 'write');
  }
}

/**
 * Load a transcript from the archive. Returns null if not found.
 */
export async function loadTranscript(
  sessionId: string
): Promise<{ messages: TranscriptMessage[]; rawLines: string[] } | null> {
  const db = await getDb();

  const msgResult = await db.execute({
    sql: 'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY turn_index',
    args: [sessionId],
  });

  if (msgResult.rows.length === 0) return null;

  const messages: TranscriptMessage[] = msgResult.rows.map(row => ({
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    timestamp: row.timestamp as string,
  }));

  const rawResult = await db.execute({
    sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
    args: [sessionId],
  });

  const rawLines = rawResult.rows.map(row => row.content as string);

  return { messages, rawLines };
}

/**
 * Load archived sessions for the history list.
 */
export async function loadArchivedSessions(opts?: {
  limit?: number;
  offset?: number;
  project?: string;
}): Promise<SessionRecord[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;

  let sql = 'SELECT session_id, project, display, message_count, created_at, updated_at FROM sessions';
  const args: any[] = [];

  if (opts?.project) {
    sql += ' WHERE project = ?';
    args.push(opts.project);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  const result = await db.execute({ sql, args });

  return result.rows.map(row => ({
    session_id: row.session_id as string,
    project: row.project as string,
    display: row.display as string,
    message_count: row.message_count as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  }));
}

/**
 * Delete a session and all its messages/raw lines from the archive.
 */
export async function deleteArchivedSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'DELETE FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
}

/**
 * Invalidate a session's archive hash so the next read triggers re-archival.
 * Used after rewind operations.
 */
export async function invalidateArchive(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE sessions SET jsonl_hash = NULL WHERE session_id = ?',
    args: [sessionId],
  });
}

// ---- Reactive archive listener ----

const LISTENER_KEY = '__fury_archive_listener__';

/**
 * Archive a single session by reading its JSONL file.
 * Used by the reactive listener — silently skips if the file
 * doesn't exist or the content hasn't changed.
 */
async function archiveSessionFromDisk(
  sessionId: string,
  project: string,
  display?: string
): Promise<void> {
  const slug = projectPathToSlug(project);
  const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await readFile(jsonlPath, 'utf-8');
  } catch {
    return; // File doesn't exist (yet) — nothing to archive
  }

  if (!content.trim()) return;

  const hash = computeHash(content);
  if (await isCurrentlyArchived(sessionId, hash)) return;

  const { messages, rawLines } = parseTranscriptJsonl(content);
  if (messages.length === 0) return;

  const label = display || messages.find(m => m.role === 'user')?.content?.substring(0, 200) || sessionId;
  await archiveTranscript(sessionId, project, label, content, messages, rawLines);
}

/**
 * When history.jsonl changes, find recently-active sessions and archive them.
 * Reads the tail of history.jsonl to identify which sessions were updated.
 */
async function onHistoryUpdated(): Promise<void> {
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const content = await readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n');

    // Only process the most recent entries (last 20) to keep it fast
    const recentLines = lines.slice(-20);
    const seen = new Set<string>();

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.sessionId || !entry.project || seen.has(entry.sessionId)) continue;
        seen.add(entry.sessionId);

        await archiveSessionFromDisk(entry.sessionId, entry.project, entry.display);
      } catch { /* skip unparseable */ }
    }
  } catch {
    // history.jsonl unreadable — skip
  }
}

/**
 * When a watched transcript JSONL changes, archive that specific session.
 */
async function onTranscriptUpdated(sessionId: string, project: string): Promise<void> {
  try {
    await archiveSessionFromDisk(sessionId, project);
  } catch (err) {
    console.error(`[ArchiveListener] Failed to archive ${sessionId}:`, err);
  }
}

/**
 * Start listening for eventBus events and reactively archive transcripts.
 * Idempotent — safe to call multiple times.
 *
 * Call this from the SSE events route alongside liveSessionScanner.start()
 * and fileWatchers.startHistoryWatcher().
 */
export function startArchiveListener(): void {
  const g = globalThis as any;
  if (g[LISTENER_KEY]) return;
  g[LISTENER_KEY] = true;

  eventBus.onApp(payload => {
    switch (payload.type) {
      case 'history-updated':
        onHistoryUpdated().catch(err =>
          console.error('[ArchiveListener] history-updated error:', err)
        );
        break;

      case 'transcript:updated':
        onTranscriptUpdated(payload.sessionId, payload.project).catch(err =>
          console.error('[ArchiveListener] transcript:updated error:', err)
        );
        break;
    }
  });
}
