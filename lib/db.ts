/**
 * SQLite database singleton for transcript archival.
 *
 * Uses @libsql/client (Turso/libSQL) with a local file-based database
 * at ~/.claude/fury.db. Survives Next.js HMR via globalThis.
 *
 * On first initialization, runs a startup scan to archive all existing
 * JSONL transcripts into the database.
 */

import { createClient, type Client } from '@libsql/client';
import { homedir } from 'os';
import { join } from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { parseTranscriptJsonl } from './transcriptParser';

const GLOBAL_KEY = '__fury_db__';
const PROMISE_KEY = '__fury_db_promise__';

function getDbPath(): string {
  const dbFile = join(homedir(), '.claude', 'fury.db');
  // libSQL requires file:// URL with forward slashes
  return 'file:///' + dbFile.replace(/\\/g, '/');
}

async function initDb(client: Client): Promise<void> {
  await client.execute('PRAGMA journal_mode=WAL');
  await client.execute('PRAGMA foreign_keys=ON');

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      project       TEXT NOT NULL,
      display       TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      jsonl_hash    TEXT,
      metadata      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content       TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      turn_index    INTEGER NOT NULL,
      UNIQUE(session_id, turn_index)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS raw_jsonl (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      line_number   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      UNIQUE(session_id, line_number)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_jsonl_session ON raw_jsonl(session_id);
  `);

  // Migration: add metadata column to existing databases
  try {
    await client.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT');
  } catch {
    // Column already exists — expected after first migration
  }

  // Migration: backfill numCompactions metadata for existing archived sessions.
  // Counts compaction user messages in raw_jsonl per session and stores the count.
  // Also migrates old hasCompaction boolean to numCompactions integer.
  try {
    const compacted = await client.execute(`
      SELECT r.session_id, COUNT(*) as cnt
      FROM raw_jsonl r
      JOIN sessions s ON s.session_id = r.session_id
      WHERE r.content LIKE '%"content":"This session is being continued from a previous conversation that ran out of context%'
        AND r.content LIKE '%"type":"user"%'
        AND (s.metadata IS NULL OR s.metadata NOT LIKE '%numCompactions%')
      GROUP BY r.session_id
    `);
    for (const row of compacted.rows) {
      const sid = row.session_id as string;
      const cnt = row.cnt as number;
      const existing = await client.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sid],
      });
      let meta: Record<string, unknown> = {};
      if (existing.rows[0]?.metadata) {
        try { meta = JSON.parse(existing.rows[0].metadata as string); } catch {}
      }
      meta.numCompactions = cnt;
      delete meta.hasCompaction;
      await client.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sid],
      });
    }
    if (compacted.rows.length > 0) {
      console.log(`[DB] Backfilled numCompactions for ${compacted.rows.length} sessions`);
    }
  } catch (err) {
    console.error('[DB] numCompactions backfill error:', err);
  }
}

/**
 * Get the database client singleton. Creates and initializes on first call.
 * Uses a promise lock to prevent duplicate initialization from concurrent callers.
 */
export function getDb(): Promise<Client> {
  const g = globalThis as any;
  if (g[GLOBAL_KEY]) return Promise.resolve(g[GLOBAL_KEY] as Client);
  if (g[PROMISE_KEY]) return g[PROMISE_KEY] as Promise<Client>;

  g[PROMISE_KEY] = (async () => {
    try {
      const client = createClient({ url: getDbPath() });
      await initDb(client);
      g[GLOBAL_KEY] = client;

      // Kick off startup scan (fire-and-forget, don't block callers)
      scanAndArchiveAll(client).catch(err =>
        console.error('[DB] Startup scan error:', err)
      );

      return client;
    } catch (err) {
      // Clear the cached promise so the next call retries initialization
      delete g[PROMISE_KEY];
      throw err;
    }
  })();

  return g[PROMISE_KEY];
}

// ---- Startup scan ----

interface HistoryInfo {
  project: string;
  display: string;
  timestamp: number;
}

async function buildHistoryMap(): Promise<Map<string, HistoryInfo>> {
  const map = new Map<string, HistoryInfo>();
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const content = await readFile(historyPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId) {
          // Keep the first (earliest) entry per session for display,
          // but update if we find a better (non-skippable) display.
          const existing = map.get(entry.sessionId);
          if (!existing) {
            map.set(entry.sessionId, {
              project: entry.project || '',
              display: entry.display || '',
              timestamp: entry.timestamp || Date.now(),
            });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* history.jsonl may not exist */ }
  return map;
}

async function scanAndArchiveAll(client: Client): Promise<void> {
  const { archiveTranscript, isCurrentlyArchived, computeHash } = await import('./transcriptArchiver');

  const projectsBase = join(homedir(), '.claude', 'projects');
  const historyMap = await buildHistoryMap();

  let dirs: string[];
  try {
    dirs = await readdir(projectsBase);
  } catch {
    console.log('[DB] No projects directory found, skipping startup scan');
    return;
  }

  let archived = 0;
  let skipped = 0;
  let errors = 0;

  for (const slug of dirs) {
    const slugDir = join(projectsBase, slug);
    let files: string[];
    try {
      const s = await stat(slugDir);
      if (!s.isDirectory()) continue;
      files = await readdir(slugDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');

      try {
        const filePath = join(slugDir, file);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) continue;

        const hash = computeHash(content);

        if (await isCurrentlyArchived(sessionId, hash)) {
          skipped++;
          continue;
        }

        const { messages, rawLines, numCompactions } = parseTranscriptJsonl(content);
        if (messages.length === 0) {
          skipped++;
          continue;
        }

        // Get metadata from history map — skip sessions with no history entry
        // since we need the real project path (not the slug) for the frontend
        const info = historyMap.get(sessionId);
        if (!info?.project) {
          skipped++;
          continue;
        }
        const project = info.project;
        const display = info.display || messages[0]?.content?.substring(0, 200) || sessionId;

        await archiveTranscript(sessionId, project, display, content, messages, rawLines, true, { numCompactions });
        archived++;
      } catch (err) {
        errors++;
        console.error(`[DB] Failed to archive ${sessionId}:`, err);
      }
    }
  }

  console.log(
    `[DB] Startup scan complete: ${archived} archived, ${skipped} already current` +
    (errors > 0 ? `, ${errors} errors` : '')
  );
}
