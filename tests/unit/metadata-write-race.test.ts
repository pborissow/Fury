/**
 * Lost-update race on sessions.metadata (P3).
 *
 * persistSessionModel and persistSessionContextWindow each do an unguarded
 * SELECT metadata → parse → set one key → UPDATE the whole blob, and are fired
 * back-to-back and unawaited on a single `result`. Without per-session
 * serialization both SELECTs read the same pre-update blob and the second UPDATE
 * clobbers the key the first wrote — dropping the model override or the window.
 *
 * These tests fire the persisters concurrently against a fresh row and assert
 * BOTH keys survive. Runs against a scratch DB (FURY_DB_PATH).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// MUST be set before the first getDb().
const TMP_DIR = mkdtempSync(join(tmpdir(), 'fury-metarace-'));
process.env.FURY_DB_PATH = join(TMP_DIR, 'test.db');

import { getDb } from '../../lib/db';
import {
  persistSessionModel,
  persistSessionContextWindow,
  updateSessionMetadata,
  loadSessionMeta,
} from '../../lib/transcriptArchiver';

afterAll(() => { try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

async function freshSession(): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  await db.execute({
    sql: 'INSERT INTO sessions (session_id, project, display, created_at, updated_at) VALUES (?,?,?,?,?)',
    args: [id, `/tmp/${id}`, 'test', Date.now(), Date.now()],
  });
  return id;
}

describe('sessions.metadata concurrent writes (P3)', () => {
  it('model + contextWindow fired concurrently both survive', async () => {
    const id = await freshSession();

    // Back-to-back and unawaited, exactly as the result handler fires them.
    await Promise.all([
      persistSessionContextWindow(id, 200_000),
      persistSessionModel(id, 'haiku'),
    ]);

    const meta = await loadSessionMeta(id);
    expect(meta?.model).toBe('haiku');
    expect(meta?.contextWindow).toBe(200_000);
  });

  it('many interleaved metadata writers preserve every key', async () => {
    const id = await freshSession();

    await Promise.all([
      persistSessionModel(id, 'opus[1m]'),
      persistSessionContextWindow(id, 1_000_000),
      updateSessionMetadata(id, { label: 'my session' }),
      updateSessionMetadata(id, { numCompactions: 3 }),
    ]);

    const meta = await loadSessionMeta(id);
    expect(meta?.model).toBe('opus[1m]');
    expect(meta?.contextWindow).toBe(1_000_000);
    expect(meta?.label).toBe('my session');
    expect(meta?.numCompactions).toBe(3);
  });
});
