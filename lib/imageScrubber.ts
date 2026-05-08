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

const PLACEHOLDER = { type: 'text', text: '[image previously analyzed]' };

/**
 * Determine whether a JSONL entry is a real user turn (vs. a tool_result
 * delivery from the CLI). A real turn is one the user originated:
 *   - string content, or
 *   - array content with at least one non-tool_result block (text, image, …)
 */
function isUserTurn(entry: any): boolean {
  if (entry?.type !== 'user') return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some((b: any) => b?.type !== 'tool_result');
  }
  return false;
}

/**
 * Scrub image content blocks from a single parsed JSONL entry (mutates).
 * Returns the number of image blocks that were replaced.
 */
function scrubEntry(entry: any): number {
  let count = 0;

  // 1) message.content[] — handle both top-level images (user pastes) and
  //    images nested inside tool_result blocks (from the Read tool, etc.)
  const msgContent = entry?.message?.content;
  if (Array.isArray(msgContent)) {
    for (let i = 0; i < msgContent.length; i++) {
      const block = msgContent[i];
      if (block?.type === 'image') {
        msgContent[i] = { ...PLACEHOLDER };
        count++;
      } else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          if (block.content[j]?.type === 'image') {
            block.content[j] = { ...PLACEHOLDER };
            count++;
          }
        }
      }
    }
  }

  // 2) toolUseResult — metadata field added by Claude Code CLI. Counts as a
  //    scrub so the file gets written back even if message.content was clean.
  if (entry?.toolUseResult?.type === 'image') {
    entry.toolUseResult = { ...PLACEHOLDER };
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
      const n = scrubEntry(p.entry);
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
 * Scrub a session's JSONL file in-place. Used by sessionManager before
 * spawning the Claude CLI to keep API requests under the 32MB limit.
 *
 * Writes back whenever bytes changed (not just when scrubbed > 0) so that
 * line-ending normalization or toolUseResult-only mutations also persist.
 * The file watcher picks up the change and re-archives to SQLite.
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

  const result = scrubImages(content, opts);
  if (result.bytesSaved <= 0) return result;

  const written = await atomicWrite(jsonlPath, result.content);
  if (!written) {
    console.warn(`[imageScrubber] Could not rename scrubbed file (in use): ${jsonlPath}`);
  }
  return result;
}
