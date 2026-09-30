/**
 * Boot-scan cache: lets the startup archive scan (scanAndArchiveAll in lib/db.ts)
 * decide a transcript is unchanged WITHOUT reading it.
 *
 * WHY THIS EXISTS: the scan's only "is this already archived?" test was
 * `isCurrentlyArchived(sessionId, computeHash(content))` — and the hash needs the
 * WHOLE file. So every boot read and SHA-256'd every top-level transcript in
 * ~/.claude/projects just to conclude that almost none of them had changed: on
 * the machine this was written on, 214 files / 575 MB, ~2.3 s per boot. With the
 * cache the same check is ~6 ms of stat() calls.
 *
 * This is a boot-time I/O saving only. It is NOT the cause of the ~2 GB non-heap
 * RSS a dev server reaches in its first minute: the full read-and-hash loop peaks
 * around 200 MB on its own, and the jump still happened on a boot where this scan
 * finished in five seconds.
 *
 * The cache keys a transcript's `size` + `mtimeMs` to the content hash we last
 * computed for it. When both still match, the hash is reused and the file is
 * never opened; the authoritative DB check (`isCurrentlyArchived`) still runs on
 * that hash, so a session whose archive row was deleted is still re-archived.
 * Anything that looks different — size, mtime, a missing or corrupt cache — falls
 * through to the original read-and-hash path. The cache is therefore a pure
 * optimization: losing it costs one slow boot, never correctness.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { furyPath } from './furyHome';

export interface ScanCacheEntry {
  /** Bytes on disk at the time `hash` was computed. */
  size: number;
  /** mtime in ms at the time `hash` was computed. */
  mtimeMs: number;
  /** computeHash() of the file's full contents. */
  hash: string;
}

/** Keyed by `<projectSlug>/<file>.jsonl` — stable across runs, unlike an abs path. */
export type ScanCache = Record<string, ScanCacheEntry>;

function cacheFile(): string {
  // Resolved lazily (not at import time): FURY_HOME migration runs after this
  // module loads. Mirrors the rule in lib/furyHome.ts.
  return furyPath('state', 'scan-cache.json');
}

/** Load the cache. An absent or unreadable cache is simply empty. */
export async function loadScanCache(): Promise<ScanCache> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as ScanCache) : {};
  } catch {
    return {}; // first boot, or corrupt — behave exactly as before the cache
  }
}

/** Persist the cache. Best-effort: a failed write only costs a re-read next boot. */
export async function saveScanCache(cache: ScanCache): Promise<void> {
  try {
    await mkdir(dirname(cacheFile()), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(cache), 'utf-8');
  } catch {
    // Ignored on purpose — see above.
  }
}

/** Whether `entry` still describes the file that `stat()` just reported. */
export function isUnchanged(
  entry: ScanCacheEntry | undefined,
  stats: { size: number; mtimeMs: number },
): entry is ScanCacheEntry {
  return !!entry && entry.size === stats.size && entry.mtimeMs === stats.mtimeMs;
}
