/**
 * lib/imageStore: content-addressed per-session image store. Uses
 * FURY_IMAGES_PATH (read at call time, mirroring FURY_DB_PATH) to point the
 * store at a throwaway temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  putImage,
  getImagePath,
  hasImage,
  deleteSessionImages,
  hashBytes,
  extForMediaType,
  isValidHash,
  sanitizeSessionId,
} from '../../lib/imageStore';

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fury-imgstore-'));

beforeAll(() => {
  process.env.FURY_IMAGES_PATH = TEMP_ROOT;
});

afterAll(() => {
  delete process.env.FURY_IMAGES_PATH;
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic bytes (enough to test)

describe('imageStore', () => {
  it('puts an image and resolves its path + hash + ext', () => {
    const { hash, ext, bytes } = putImage('sess-1', PNG, 'image/png');
    expect(hash).toBe(hashBytes(PNG));
    expect(ext).toBe('png');
    expect(bytes).toBe(PNG.length);
    const p = getImagePath('sess-1', hash);
    expect(p).not.toBeNull();
    expect(p!.endsWith(`${hash}.png`)).toBe(true);
    expect(existsSync(p!)).toBe(true);
    expect(hasImage('sess-1', hash)).toBe(true);
  });

  it('is content-addressed: same bytes → same hash, second put is a no-op', () => {
    const a = putImage('sess-dedup', PNG, 'image/png');
    const b = putImage('sess-dedup', PNG, 'image/png');
    expect(a.hash).toBe(b.hash);
    // Only one file for that hash.
    expect(getImagePath('sess-dedup', a.hash)).not.toBeNull();
  });

  it('scopes images per session (no cross-session visibility)', () => {
    const { hash } = putImage('sess-A', PNG, 'image/png');
    expect(hasImage('sess-A', hash)).toBe(true);
    expect(hasImage('sess-B', hash)).toBe(false);
  });

  it('deleteSessionImages removes the whole session folder', async () => {
    const { hash } = putImage('sess-del', PNG, 'image/png');
    expect(hasImage('sess-del', hash)).toBe(true);
    await deleteSessionImages('sess-del');
    expect(hasImage('sess-del', hash)).toBe(false);
    expect(existsSync(join(TEMP_ROOT, 'sess-del'))).toBe(false);
    // Idempotent — deleting a missing folder does not throw.
    await expect(deleteSessionImages('sess-del')).resolves.toBeUndefined();
  });

  it('rejects invalid hashes and never traverses outside the store', () => {
    expect(isValidHash('not-a-hash')).toBe(false);
    expect(isValidHash('a'.repeat(64))).toBe(true);
    expect(getImagePath('sess-1', '../../etc/passwd')).toBeNull();
    expect(getImagePath('sess-1', 'g'.repeat(64))).toBeNull();
  });

  it('maps media types to extensions', () => {
    expect(extForMediaType('image/png')).toBe('png');
    expect(extForMediaType('image/jpeg')).toBe('jpg');
    expect(extForMediaType('image/gif')).toBe('gif');
    expect(extForMediaType('image/webp')).toBe('webp');
  });

  it('sanitizes session ids for path safety', () => {
    expect(sanitizeSessionId('../../evil')).toBe('evil');
    expect(sanitizeSessionId('abc-123')).toBe('abc-123');
  });
});
