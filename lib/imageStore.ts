/**
 * Per-session, content-addressed image store.
 *
 * Layout: <root>/<sessionId>/<sha256>.<ext>
 *   - Root defaults to ~/.fury/images (see lib/furyHome.ts), overridable via
 *     FURY_IMAGES_PATH (mirrors FURY_DB_PATH's pattern in lib/db.ts so tests
 *     can point at a scratch dir).
 *   - Files are addressed by the SHA-256 of their bytes, so re-storing the same
 *     image within a session is a no-op (intra-session dedup). There is NO
 *     cross-session dedup — the per-session folder IS the index, which makes
 *     archival cleanup a single `rm -rf <sessionId>/`.
 *
 * The filesystem is the source of truth for image bytes; SQLite/JSONL hold only
 * `fury-img://<hash>` reference placeholders (see lib/imageScrubber.ts). There
 * is deliberately no images table.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { furyImagesRoot } from './furyHome';
import { atomicWriteFileSync } from './atomicWrite';

/** Anthropic-accepted image media types. */
const MEDIA_TYPE_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function extForMediaType(mediaType: string): string {
  return MEDIA_TYPE_TO_EXT[mediaType] ?? 'bin';
}

export function mediaTypeForExt(ext: string): string {
  return EXT_TO_MEDIA_TYPE[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Root directory for the image store (env-overridable, like FURY_DB_PATH). */
export function imageStoreRoot(): string {
  return furyImagesRoot();
}

/** SHA-256 of the given bytes, lowercase hex. */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A 64-char lowercase hex hash and nothing else. */
export function isValidHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

/** A Claude session id (uuid-ish) — letters, digits, dashes only. */
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, '');
}

function sessionDir(sessionId: string): string {
  return join(imageStoreRoot(), sanitizeSessionId(sessionId));
}

export interface StoredImage {
  hash: string;
  ext: string;
  bytes: number;
}

/**
 * Persist image bytes for a session. Content-addressed: if the same hash
 * already exists in this session, the write is skipped (dedup).
 *
 * Synchronous so it can be called from the (synchronous) scrubImages walk
 * without threading async through the whole scrubber; the volumes are small
 * (downscaled screenshots) and this runs off the request hot path.
 */
export function putImage(sessionId: string, bytes: Buffer, mediaType: string): StoredImage {
  const hash = hashBytes(bytes);
  const ext = extForMediaType(mediaType);
  const dir = sessionDir(sessionId);
  const filePath = join(dir, `${hash}.${ext}`);
  if (!existsSync(filePath)) {
    mkdirSync(dir, { recursive: true });
    // Atomic (temp+rename): a crash/ENOSPC mid-write must not leave a torn
    // file at the content-addressed path — the existsSync dedup above would
    // treat it as present forever and the corrupt bytes would be served for
    // every later request of this hash.
    atomicWriteFileSync(filePath, bytes);
  }
  return { hash, ext, bytes: bytes.length };
}

/**
 * Resolve the on-disk path for a stored image, or null if it isn't present.
 * The extension isn't part of the ref, so we probe the known extensions.
 * Reads are confined to the (sanitized) session dir — no path traversal.
 */
export function getImagePath(sessionId: string, hash: string): string | null {
  if (!isValidHash(hash)) return null;
  const dir = sessionDir(sessionId);
  for (const ext of Object.keys(EXT_TO_MEDIA_TYPE)) {
    const p = join(dir, `${hash}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function hasImage(sessionId: string, hash: string): boolean {
  return getImagePath(sessionId, hash) !== null;
}

/**
 * Remove an entire session's image folder. Called when a session is archived
 * (soft-deleted). Best-effort — a missing folder is not an error.
 */
export async function deleteSessionImages(sessionId: string): Promise<void> {
  const dir = sessionDir(sessionId);
  await rm(dir, { recursive: true, force: true });
}
