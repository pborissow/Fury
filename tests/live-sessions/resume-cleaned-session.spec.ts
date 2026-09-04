/**
 * Probe test — does resuming a session whose JSONL was deleted by Claude CLI's
 * 30-day cleanup wipe the archived messages?
 *
 * Theory under test:
 *   1. Claude CLI deletes JSONLs >30 days old.
 *   2. Fury sees no JSONL → spawns `claude --session-id <uuid>` (NEW session)
 *      instead of `--resume` (sessionManager.ts:241-262).
 *   3. The new empty JSONL gets picked up by Fury's archiver, which runs
 *      DELETE FROM messages + reinsert (transcriptArchiver.ts:99-101), wiping
 *      the historical archive entry for that session_id.
 *
 * Subject: session 85defa96-1b44-4030-8978-ca2b2db9db5d, last touched
 * 2026-03-10 7:31 PM EDT (2 user turns about a Java AuditWriter fix).
 * JSONL is already gone from disk (confirmed via find before the test).
 *
 * The SQLite DB is backed up to ~/.claude/fury-backup-* BEFORE this test runs.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createClient } from '@libsql/client';
import { furyDbPath } from '../../lib/furyHome';

const SESSION_ID = '85defa96-1b44-4030-8978-ca2b2db9db5d';
const PROJECT_PATH = '/Users/peterborrisow/Documents/Java/BoatsGroup/maven/YC2-357';
const SLUG = '-Users-peterborrisow-Documents-Java-BoatsGroup-maven-YC2-357';
// Resolve like the app does (~/.fury/fury.db with legacy ~/.claude fallback) —
// the old hardcoded legacy path broke when the home migration moved the DB.
const DB = furyDbPath();
const JSONL = join(homedir(), '.claude', 'projects', SLUG, `${SESSION_ID}.jsonl`);

// Query via @libsql/client (the same driver Fury's archiver uses on the same
// file) instead of shelling out to a `sqlite3` CLI the machine may not have.
const db = createClient({ url: 'file:///' + DB.replace(/\\/g, '/') });
async function sqliteJson(query: string): Promise<any[]> {
  const res = await db.execute(query);
  return res.rows.map((r) => ({ ...r }));
}

async function sessionRow() {
  return (await sqliteJson(
    `SELECT session_id, message_count, jsonl_hash,
            datetime(created_at/1000,'unixepoch','localtime') AS created,
            datetime(updated_at/1000,'unixepoch','localtime') AS updated,
            json_extract(metadata,'$.label') AS label
     FROM sessions WHERE session_id='${SESSION_ID}'`
  ))[0] || null;
}

async function messageStats() {
  const rows = await sqliteJson(
    `SELECT role, COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last
     FROM messages WHERE session_id='${SESSION_ID}' GROUP BY role`
  );
  // Number(): libsql may surface COUNT(*) as BigInt; toBe(11) needs a number.
  const total = Number((await sqliteJson(`SELECT COUNT(*) AS n FROM messages WHERE session_id='${SESSION_ID}'`))[0]?.n ?? 0);
  const historical = Number((await sqliteJson(
    `SELECT COUNT(*) AS n FROM messages WHERE session_id='${SESSION_ID}' AND timestamp LIKE '2026-03-10%'`
  ))[0]?.n ?? 0);
  return { rows, total, historical };
}

async function waitFor<T>(probe: () => T | null | Promise<T | null>, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await probe();
    if (v !== null && v !== undefined && v !== false) return v;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

test('resuming a JSONL-less old session wipes the SQLite archive', async ({ page }) => {
  test.setTimeout(120_000);

  // ---- BASELINE ----
  const before = await sessionRow();
  const beforeStats = await messageStats();
  console.log('\n[TEST] ============ BEFORE ============');
  console.log('[TEST] Session row:', before);
  console.log('[TEST] Total archived messages:', beforeStats.total);
  console.log('[TEST] Role breakdown:', beforeStats.rows);
  console.log('[TEST] Historical (2026-03-10) messages:', beforeStats.historical);
  console.log('[TEST] JSONL exists on disk?', existsSync(JSONL));

  expect(before).not.toBeNull();
  expect(beforeStats.total).toBe(11);
  expect(beforeStats.historical).toBe(11);
  expect(existsSync(JSONL)).toBe(false);

  // ---- Open Fury (best-effort UI step for log/visibility) ----
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // ---- ACTION: submit a prompt via /api/claude (same path the UI uses) ----
  const promptText = 'Reply with exactly OK and nothing else. Do not call any tools.';
  console.log('\n[TEST] ============ ACTION ============');
  console.log('[TEST] POST /api/claude  prompt:', JSON.stringify(promptText));
  const t0 = Date.now();
  const apiRes = await page.request.post('/api/claude', {
    data: { prompt: promptText, sessionId: SESSION_ID, projectPath: PROJECT_PATH },
  });
  expect(apiRes.ok()).toBe(true);
  console.log('[TEST] /api/claude accepted:', apiRes.status());

  // ---- Wait for the JSONL to be created on disk (proves CLI spawned) ----
  const jsonlAppeared = await waitFor(() => existsSync(JSONL) ? Date.now() : null, 45_000, 250);
  console.log(`[TEST] JSONL appeared on disk after ${jsonlAppeared ? jsonlAppeared - t0 : 'NEVER'}ms`);
  console.log('[TEST] JSONL path:', JSONL);
  if (jsonlAppeared) {
    const content = readFileSync(JSONL, 'utf-8');
    console.log('[TEST] JSONL size:', content.length, 'bytes, lines:', content.split('\n').filter(Boolean).length);
  }

  // ---- TRIGGER: simulate the UI viewing the session.
  // GET /api/transcript is what the UI calls when a session is opened, and it
  // unconditionally calls archiveTranscript() with whatever's in the current
  // JSONL (route.ts:327). This is the actual destructive call path.
  console.log('[TEST] Calling GET /api/transcript to mimic UI session view…');
  const transcriptRes = await page.request.get(
    `/api/transcript?sessionId=${SESSION_ID}&project=${encodeURIComponent(PROJECT_PATH)}`
  );
  console.log('[TEST] /api/transcript status:', transcriptRes.status());

  // ---- Wait for archive to update (updated_at changes vs baseline) ----
  const baselineUpdated = before!.updated;
  const updatedRow = await waitFor(async () => {
    const r = await sessionRow();
    return r && r.updated !== baselineUpdated ? r : null;
  }, 45_000, 500);
  console.log(`[TEST] Archive updated_at changed? ${updatedRow ? 'YES' : 'NO (no update detected within 45s)'}`);

  // ---- AFTER ----
  const after = await sessionRow();
  const afterStats = await messageStats();
  console.log('\n[TEST] ============ AFTER ============');
  console.log('[TEST] Session row:', after);
  console.log('[TEST] Total archived messages:', afterStats.total);
  console.log('[TEST] Role breakdown:', afterStats.rows);
  console.log('[TEST] Historical (2026-03-10) messages still present:', afterStats.historical);

  // ---- VERDICT ----
  console.log('\n[TEST] ============ VERDICT ============');
  console.log(`[TEST] Historical (2026-03-10) before: ${beforeStats.historical}, after: ${afterStats.historical}`);
  console.log(`[TEST] Total archived before: ${beforeStats.total}, after: ${afterStats.total}`);
  console.log('[TEST] Backup path: see /tmp/fury-backup-path.txt');

  // The whole point of the fix: every historical message must survive.
  expect(afterStats.historical).toBe(beforeStats.historical);
  // And the archive must not have shrunk (it may have grown if CLI appended).
  expect(afterStats.total).toBeGreaterThanOrEqual(beforeStats.total);

  // Try to stop the Claude CLI subprocess we spawned (best effort — we don't
  // want a real backend call lingering). Use the streaming-stop endpoint.
  try {
    await page.request.post('/api/stream-buffer', {
      data: { sessionId: SESSION_ID, action: 'stop' },
    }).catch(() => {});
  } catch { /* ignore */ }
});
