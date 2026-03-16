#!/usr/bin/env npx tsx
/**
 * Standalone script to populate the Fury transcript database.
 * Scans all ~/.claude/projects/* JSONL files and archives them to ~/.claude/fury.db.
 *
 * Usage:  npx tsx scripts/populate-db.ts [--dry-run] [--verbose]
 */

import { createClient } from '@libsql/client';
import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { parseTranscriptJsonl } from '../lib/transcriptParser';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function log(msg: string) {
  console.log(msg);
}

function verbose(msg: string) {
  if (VERBOSE) console.log(`  ${msg}`);
}

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
        if (entry.sessionId && !map.has(entry.sessionId)) {
          map.set(entry.sessionId, {
            project: entry.project || '',
            display: entry.display || '',
            timestamp: entry.timestamp || Date.now(),
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* history.jsonl may not exist */ }
  return map;
}

async function main() {
  const dbFile = join(homedir(), '.claude', 'fury.db');
  const dbUrl = 'file:///' + dbFile.replace(/\\/g, '/');

  log(`Database: ${dbFile}`);
  if (DRY_RUN) log('DRY RUN — no writes will be performed\n');

  const db = createClient({ url: dbUrl });
  await db.execute('PRAGMA journal_mode=WAL');
  await db.execute('PRAGMA foreign_keys=ON');

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, project TEXT NOT NULL, display TEXT NOT NULL,
      message_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, jsonl_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL, timestamp TEXT NOT NULL, turn_index INTEGER NOT NULL,
      UNIQUE(session_id, turn_index)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE TABLE IF NOT EXISTS raw_jsonl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      line_number INTEGER NOT NULL, content TEXT NOT NULL,
      UNIQUE(session_id, line_number)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_jsonl_session ON raw_jsonl(session_id);
  `);

  // Check existing state
  const existingCount = await db.execute('SELECT COUNT(*) as cnt FROM sessions');
  log(`Existing sessions in DB: ${existingCount.rows[0].cnt}\n`);

  const historyMap = await buildHistoryMap();
  log(`Sessions in history.jsonl: ${historyMap.size}`);

  const projectsBase = join(homedir(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(projectsBase);
  } catch {
    log('No projects directory found — nothing to scan.');
    process.exit(0);
  }

  let totalJsonl = 0;
  let archived = 0;
  let skipped = 0;
  let skippedNoHistory = 0;
  let skippedEmpty = 0;
  let unchanged = 0;
  let errors = 0;

  for (const slug of dirs) {
    const slugDir = join(projectsBase, slug);
    let files: string[];
    try {
      const s = await stat(slugDir);
      if (!s.isDirectory()) continue;
      files = await readdir(slugDir);
    } catch { continue; }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    verbose(`${slug}/ — ${jsonlFiles.length} JSONL file(s)`);

    for (const file of jsonlFiles) {
      totalJsonl++;
      const sessionId = file.replace('.jsonl', '');

      try {
        const filePath = join(slugDir, file);
        const content = await readFile(filePath, 'utf-8');

        if (!content.trim()) {
          verbose(`  ${sessionId}: empty — skipped`);
          skippedEmpty++;
          continue;
        }

        const hash = computeHash(content);

        // Check if already archived with same hash
        const existing = await db.execute({
          sql: 'SELECT jsonl_hash FROM sessions WHERE session_id = ?',
          args: [sessionId],
        });
        if (existing.rows.length > 0 && existing.rows[0].jsonl_hash === hash) {
          verbose(`  ${sessionId}: unchanged — skipped`);
          unchanged++;
          continue;
        }

        const { messages, rawLines } = parseTranscriptJsonl(content);
        if (messages.length === 0) {
          verbose(`  ${sessionId}: no displayable messages — skipped`);
          skippedEmpty++;
          continue;
        }

        const info = historyMap.get(sessionId);
        if (!info?.project) {
          verbose(`  ${sessionId}: no history entry — skipped`);
          skippedNoHistory++;
          continue;
        }

        const project = info.project;
        const display = (info.display || messages[0]?.content?.substring(0, 200) || sessionId).substring(0, 200);
        const now = Date.now();
        const createdAt = existing.rows.length > 0
          ? (existing.rows[0].created_at as number ?? now)
          : (new Date(messages[0].timestamp).getTime() || now);

        const isUpdate = existing.rows.length > 0;

        if (!DRY_RUN) {
          const CHUNK_SIZE = 500;
          const preamble = [
            {
              sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, jsonl_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                      project = excluded.project, display = excluded.display,
                      message_count = excluded.message_count, updated_at = excluded.updated_at,
                      jsonl_hash = excluded.jsonl_hash`,
              args: [sessionId, project, display, messages.length, createdAt, now, hash],
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
          for (let i = 0; i < rawLines.length; i++) {
            inserts.push({
              sql: 'INSERT INTO raw_jsonl (session_id, line_number, content) VALUES (?, ?, ?)',
              args: [sessionId, i, rawLines[i]],
            });
          }

          const firstChunk = inserts.slice(0, CHUNK_SIZE);
          await db.batch([...preamble, ...firstChunk], 'write');
          for (let offset = CHUNK_SIZE; offset < inserts.length; offset += CHUNK_SIZE) {
            await db.batch(inserts.slice(offset, offset + CHUNK_SIZE), 'write');
          }
        }

        archived++;
        log(`  ${isUpdate ? 'Updated' : 'Archived'}: ${sessionId} (${messages.length} messages, ${rawLines.length} raw lines) — "${display.substring(0, 60)}${display.length > 60 ? '...' : ''}"`);
      } catch (err) {
        errors++;
        console.error(`  ERROR: ${sessionId}: ${err}`);
      }
    }
  }

  log('');
  log('=== Summary ===');
  log(`JSONL files found:    ${totalJsonl}`);
  log(`Archived (new/updated): ${archived}`);
  log(`Unchanged (same hash):  ${unchanged}`);
  log(`Skipped (no history):   ${skippedNoHistory}`);
  log(`Skipped (empty/no msgs): ${skippedEmpty}`);
  log(`Errors:                 ${errors}`);

  // Final DB stats
  if (!DRY_RUN) {
    const sessCount = await db.execute('SELECT COUNT(*) as cnt FROM sessions');
    const msgCount = await db.execute('SELECT COUNT(*) as cnt FROM messages');
    const rawCount = await db.execute('SELECT COUNT(*) as cnt FROM raw_jsonl');
    log('');
    log('=== Database ===');
    log(`Sessions: ${sessCount.rows[0].cnt}`);
    log(`Messages: ${msgCount.rows[0].cnt}`);
    log(`Raw JSONL lines: ${rawCount.rows[0].cnt}`);
  }

  db.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
