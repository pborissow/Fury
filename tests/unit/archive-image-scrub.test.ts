/**
 * The archiver must strip inline base64 image data out of the copy it writes to
 * `raw_jsonl` (the "no base64 in DB" goal). This runs on the archiver's own
 * in-memory content — it never touches the live JSONL — so it's safe regardless
 * of the per-turn live scrub. Ephemeral mode → bare placeholder + no bytes;
 * persist mode → fury-img://<hash> ref + bytes externalized to the store.
 *
 * Same harness as archive-for-delete.test.ts: real initDb + archive path
 * against a throwaway DB via a mocked homedir (which also relocates the image
 * store, since imageStore defaults under ~/.fury — see lib/furyHome.ts).
 * settingsPersistence is mocked so the test controls imagePersistence.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'fury-archive-imgscrub-'));
mkdirSync(join(TEMP_HOME, '.claude'), { recursive: true });

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEMP_HOME };
});

let mockPersist = false;
vi.mock('../../lib/settingsPersistence', () => ({
  settingsPersistence: {
    loadSettings: async () => ({ imagePersistence: mockPersist ? 'persist' : 'ephemeral', keepRecentTurns: 1 }),
    saveSettings: async () => ({}),
  },
  verifyPassword: () => false,
}));

const PROJECT = '/tmp/fury-archive-imgscrub-project';
const TS = '2026-08-04T12:00:00.000Z';
const SECRET_B64 = Buffer.from('SUPER-SECRET-IMAGE-BYTES-THAT-MUST-NOT-REACH-THE-DB').toString('base64');

async function writeJsonl(sessionId: string, lines: string[]): Promise<void> {
  const { projectPathToSlug } = await import('../../lib/utils');
  const dir = join(TEMP_HOME, '.claude', 'projects', projectPathToSlug(PROJECT));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function imageConvo(): string[] {
  return [
    JSON.stringify({
      type: 'user', timestamp: TS, uuid: 'u-1',
      message: { role: 'user', content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SECRET_B64 } },
      ] },
    }),
    JSON.stringify({ type: 'assistant', timestamp: TS, uuid: 'a-1', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'a picture' }] } }),
  ];
}

async function rawJsonlText(sessionId: string): Promise<string> {
  const { getDb } = await import('../../lib/db');
  const db = await getDb();
  const r = await db.execute({
    sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
    args: [sessionId],
  });
  return r.rows.map(row => row.content as string).join('\n');
}

describe('archiver strips inline base64 from raw_jsonl', () => {
  afterAll(async () => {
    try { const { getDb } = await import('../../lib/db'); (await getDb()).close(); } catch { /* ignore */ }
    try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('ephemeral mode: no base64 in the DB, bare placeholder instead, no bytes stored', async () => {
    mockPersist = false;
    const SID = 'img-ephemeral';
    await writeJsonl(SID, imageConvo());
    const { archiveSessionFromDisk } = await import('../../lib/transcriptArchiver');
    await archiveSessionFromDisk(SID, PROJECT);

    const raw = await rawJsonlText(SID);
    expect(raw).not.toContain(SECRET_B64);
    expect(raw).toContain('[image previously analyzed]');
    expect(raw).not.toContain('fury-img://');
    // The typed text survives.
    expect(raw).toContain('describe this');
  });

  it('persist mode: DB carries a fury-img ref, bytes land in the per-session store', async () => {
    mockPersist = true;
    const SID = 'img-persist';
    await writeJsonl(SID, imageConvo());
    const { archiveSessionFromDisk } = await import('../../lib/transcriptArchiver');
    await archiveSessionFromDisk(SID, PROJECT);

    const raw = await rawJsonlText(SID);
    expect(raw).not.toContain(SECRET_B64);
    expect(raw).toContain('fury-img://');

    const { hashBytes, hasImage } = await import('../../lib/imageStore');
    const hash = hashBytes(Buffer.from(SECRET_B64, 'base64'));
    expect(raw).toContain(`fury-img://${hash}`);
    expect(hasImage(SID, hash)).toBe(true);
  });

  it('archiveForDelete also strips base64 before purging images', async () => {
    mockPersist = false;
    const SID = 'img-delete';
    await writeJsonl(SID, imageConvo());
    const { archiveForDelete } = await import('../../lib/transcriptArchiver');
    const durable = await archiveForDelete(SID, PROJECT);
    expect(durable).toBe(true);
    const raw = await rawJsonlText(SID);
    expect(raw).not.toContain(SECRET_B64);
    // Image folder purged on archive.
    expect(existsSync(join(TEMP_HOME, '.fury', 'images', SID))).toBe(false);
  });
});
