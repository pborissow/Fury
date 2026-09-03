/**
 * Image scrubber — removes base64 image data from JSONL transcript lines.
 *
 * Designed for two use cases:
 *   1. One-shot cleanup of bloated sessions (scrubAllImages / scrubSessionJsonl)
 *   2. On-the-fly scrubbing during active sessions where only the most recent
 *      turn's images need to survive (keepRecentTurns option)
 *
 * Image content blocks are replaced with a lightweight text block so the
 * conversation structure stays valid for API replay. Both top-level images
 * (e.g. user-pasted screenshots in `message.content[]`) and tool-result
 * images (e.g. from the Read tool's `tool_result.content[]`) are handled.
 */

import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { projectPathToSlug } from './utils';
import { putImage } from './imageStore';
import { isRealUserTurnEntry } from './transcriptParser';
import { IMAGE_PLACEHOLDER_TEXT, imageRefText } from './imageRefs';
import { ACCEPTED_IMAGE_MEDIA_TYPES } from './types';

export interface ScrubOptions {
  /**
   * Number of recent user turns whose images should be preserved.
   * A "turn" is a user message that contains real input (string content,
   * or an array containing anything other than tool_result blocks).
   *   0  = scrub every image (default)
   *   1  = keep only the current/last turn's images
   *   N  = keep the last N turns' images
   */
  keepRecentTurns?: number;
  /**
   * When set, image blocks in older turns are EXTERNALIZED instead of discarded:
   * the base64 bytes are written to the per-session on-disk store and the block
   * is replaced with a `fury-img://<hash>` ref placeholder (so the thumbnail can
   * be rehydrated later). Requires `sessionId`. When absent (default), older
   * images collapse to the bare "[image previously analyzed]" placeholder and
   * the bytes are dropped (ephemeral mode).
   */
  persist?: boolean;
  /** Session id for the on-disk store when `persist` is set. */
  sessionId?: string;
}

export interface ScrubResult {
  /** Scrubbed JSONL content (joined with newlines) */
  content: string;
  /** Number of image blocks that were scrubbed */
  scrubbed: number;
  /** Number of image blocks that were kept */
  kept: number;
  /** Bytes saved by scrubbing */
  bytesSaved: number;
}

interface ParsedLine {
  raw: string;
  entry: any | null;
  /** Index of the user-turn this line belongs to (-1 if N/A) */
  turnIndex: number;
  hasImage: boolean;
}

// Wire format shared with the transcript parser — see lib/imageRefs.ts.
const PLACEHOLDER = { type: 'text', text: IMAGE_PLACEHOLDER_TEXT };

/** Ref placeholder text carrying the store hash. Parseable by the transcript
 *  parser (fury-img://<hash>) and still a valid text block for API replay. */
function refPlaceholder(hash: string) {
  return { type: 'text', text: imageRefText(hash) };
}

/**
 * Externalize a single base64 image block to the per-session store. Returns the
 * content hash, or null if the block isn't a base64 image we can persist (in
 * which case the caller falls back to the bare placeholder).
 *
 * Media types outside the accepted set are NOT externalized: the store would
 * file them under an extension getImagePath never probes (`.bin`), producing a
 * fury-img:// ref that can never resolve — a permanent 404 with the inline
 * base64 already destroyed. Falling back to the bare placeholder is honest
 * about the bytes being gone.
 */
function externalizeImageBlock(sessionId: string, block: any): string | null {
  const src = block?.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
  try {
    const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
    if (!ACCEPTED_IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
    const bytes = Buffer.from(src.data, 'base64');
    if (bytes.length === 0) return null;
    const { hash } = putImage(sessionId, bytes, mediaType);
    return hash;
  } catch {
    return null;
  }
}

/** Build the replacement block for a scrubbed image: a ref placeholder when
 *  externalization succeeds, else the bare placeholder. */
function replacementFor(sessionId: string | undefined, persist: boolean, block: any) {
  if (persist && sessionId) {
    const hash = externalizeImageBlock(sessionId, block);
    if (hash) return refPlaceholder(hash);
  }
  return { ...PLACEHOLDER };
}

/**
 * Turn boundary — DELEGATED to the parser's isRealUserTurnEntry so the scrubber
 * counts turns exactly like the renderer does. The scrubber previously counted
 * every string-content user entry (task-notifications, <command-name> markers,
 * isMeta reminders) as a turn, inflating the index so keepRecentTurns=1 could
 * scrub the just-pasted image on its own turn's result event. Real transcripts
 * routinely carry runs of such entries mid-turn (6+ consecutive
 * task-notifications observed), so this was common, not hypothetical.
 */
function isUserTurn(entry: any): boolean {
  return isRealUserTurnEntry(entry);
}

/**
 * Scrub image content blocks from a single parsed JSONL entry (mutates).
 * Returns the number of image blocks that were replaced.
 */
function scrubEntry(entry: any, sessionId?: string, persist = false): number {
  let count = 0;

  // 1) message.content[] — handle both top-level images (user pastes) and
  //    images nested inside tool_result blocks (from the Read tool, etc.)
  const msgContent = entry?.message?.content;
  if (Array.isArray(msgContent)) {
    for (let i = 0; i < msgContent.length; i++) {
      const block = msgContent[i];
      if (block?.type === 'image') {
        msgContent[i] = replacementFor(sessionId, persist, block);
        count++;
      } else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          if (block.content[j]?.type === 'image') {
            block.content[j] = replacementFor(sessionId, persist, block.content[j]);
            count++;
          }
        }
      }
    }
  }

  // 2) toolUseResult — metadata field added by Claude Code CLI. Counts as a
  //    scrub so the file gets written back even if message.content was clean.
  //    Routed through replacementFor like every other image site, so persist
  //    mode leaves a resolvable ref here too (the planned tool-UI rendering
  //    reads toolUseResult) instead of a ref-less bare placeholder.
  if (entry?.toolUseResult?.type === 'image') {
    entry.toolUseResult = replacementFor(sessionId, persist, entry.toolUseResult);
    count++;
  }

  return count;
}

/**
 * Count images that would be kept (mirrors scrubEntry's discovery logic).
 */
function countImages(entry: any): number {
  let n = 0;
  const msgContent = entry?.message?.content;
  if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (block?.type === 'image') n++;
      else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        n += block.content.filter((c: any) => c?.type === 'image').length;
      }
    }
  }
  return n;
}

/**
 * Scrub base64 images from raw JSONL content.
 *
 * @param jsonlContent  Full JSONL file content (newline-separated JSON lines)
 * @param opts          Scrub options (see ScrubOptions)
 * @returns             ScrubResult with scrubbed content and statistics
 */
export function scrubImages(jsonlContent: string, opts?: ScrubOptions): ScrubResult {
  const keepRecentTurns = opts?.keepRecentTurns ?? 0;
  const persist = opts?.persist === true && !!opts?.sessionId;
  const sessionId = opts?.sessionId;
  // Normalize CRLF → LF so output ends up with consistent line endings even
  // if the input was a mix (Windows-authored files, copy-paste, etc.)
  const rawLines = jsonlContent.split('\n').map(l => l.replace(/\r$/, ''));

  // ---- Pass 1: parse lines, assign turn indices ----
  const parsed: ParsedLine[] = [];
  let currentTurn = -1;

  for (const raw of rawLines) {
    if (!raw.trim()) {
      parsed.push({ raw, entry: null, turnIndex: -1, hasImage: false });
      continue;
    }
    try {
      const entry = JSON.parse(raw);
      if (isUserTurn(entry)) currentTurn++;
      const hasImage = raw.includes('"type":"image"') || raw.includes('"type": "image"');
      parsed.push({ raw, entry, turnIndex: currentTurn, hasImage });
    } catch {
      parsed.push({ raw, entry: null, turnIndex: -1, hasImage: false });
    }
  }

  const totalTurns = currentTurn + 1;
  const scrubBefore = totalTurns - keepRecentTurns; // turns < this index get scrubbed

  // ---- Pass 2: scrub image blocks in older turns ----
  let scrubbed = 0;
  let kept = 0;
  const originalSize = jsonlContent.length;

  const outputLines: string[] = [];

  for (const p of parsed) {
    if (!p.hasImage || p.entry === null) {
      outputLines.push(p.raw);
      continue;
    }

    if (p.turnIndex < scrubBefore) {
      const n = scrubEntry(p.entry, sessionId, persist);
      scrubbed += n;
      outputLines.push(JSON.stringify(p.entry));
    } else {
      kept += countImages(p.entry);
      outputLines.push(p.raw);
    }
  }

  const content = outputLines.join('\n');
  const bytesSaved = originalSize - content.length;

  return { content, scrubbed, kept, bytesSaved };
}

/**
 * Atomically write the scrubbed content next to the JSONL via a `.tmp` +
 * rename. On Windows the rename can fail with EBUSY/EACCES if another
 * process holds the file open — we surface that as a no-op and let the
 * caller decide how to react (we don't want a concurrent file lock to
 * crash the request that triggered the scrub).
 */
async function atomicWrite(jsonlPath: string, content: string): Promise<boolean> {
  const tmpPath = jsonlPath + '.scrub.tmp';
  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, jsonlPath);
    return true;
  } catch (err: any) {
    // Best-effort cleanup of the orphan temp file
    try { await unlink(tmpPath); } catch { /* ignore */ }
    if (err?.code === 'EBUSY' || err?.code === 'EACCES' || err?.code === 'EPERM') {
      return false;
    }
    throw err;
  }
}

/**
 * Scrub a session's JSONL file in-place, replacing it via `.tmp`+rename.
 *
 * ⚠️ CONCURRENCY: rename swaps the inode. Two hazards were considered:
 *
 *  1. HELD FD — if the `claude` subprocess kept the JSONL open, a rename would
 *     detach its fd and every later append would be lost. EMPIRICALLY RULED
 *     OUT (2026-09-02): `lsof` on a live claude CLI process *mid-turn, while
 *     actively writing its transcript* shows ZERO open .jsonl fds — the CLI
 *     opens/appends/closes per line. Re-verify if a CLI update changes its
 *     write pattern.
 *  2. REOPEN-APPEND RACE — a line appended between our read and the rename
 *     lands on the old inode and is discarded. Guarded below by a READ-BACK
 *     COMPARE (stronger than the previous size/mtime stat check, which could
 *     miss a same-length rewrite within mtime granularity): if the bytes on
 *     disk no longer equal what we scrubbed, skip the rename; the next turn's
 *     scrub retries. The residual stat→rename window is microseconds, during
 *     a moment (turn settled) when the CLI is idle.
 *
 * The DB-leanness goal does NOT depend on this path — the archiver scrubs its
 * own in-memory copy — so a skipped rewrite costs only temporary JSONL bloat.
 *
 * Writes back whenever bytes changed (not just when scrubbed > 0) so that
 * line-ending normalization or toolUseResult-only mutations also persist.
 *
 * Returns the scrub stats (or null if the file is missing or empty).
 */
export async function scrubSessionFile(
  sessionId: string,
  projectPath: string,
  opts?: ScrubOptions,
): Promise<ScrubResult | null> {
  const slug = projectPathToSlug(projectPath);
  const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);

  if (!existsSync(jsonlPath)) return null;

  const content = await readFile(jsonlPath, 'utf-8');
  if (!content.trim()) return null;

  // Fast-path: no images present at all
  if (!content.includes('"type":"image"') && !content.includes('"type": "image"')) {
    return { content, scrubbed: 0, kept: 0, bytesSaved: 0 };
  }

  // The store is keyed by this session, so inject the id here — callers only
  // need to decide persist vs. ephemeral (opts.persist).
  const result = scrubImages(content, { ...opts, sessionId });
  if (result.bytesSaved <= 0) return result;

  // Read-back guard: if the file changed since we read it, a writer is active —
  // skip the rename so we don't clobber freshly-appended lines. The next turn's
  // scrub retries. (Bytes were already externalized to the store by scrubImages
  // in persist mode, which is idempotent, so a skipped rename never loses
  // image bytes.)
  try {
    const recheck = await readFile(jsonlPath, 'utf-8');
    if (recheck !== content) {
      console.warn(`[imageScrubber] JSONL changed under scrub; skipping rewrite to avoid clobbering appends: ${jsonlPath}`);
      return result;
    }
  } catch {
    return result; // re-read failed — err on the side of not renaming
  }

  const written = await atomicWrite(jsonlPath, result.content);
  if (!written) {
    console.warn(`[imageScrubber] Could not rename scrubbed file (in use): ${jsonlPath}`);
  }
  return result;
}
