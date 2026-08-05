/**
 * Atomic file writes: write a temp file in the same directory, then rename it
 * over the target.
 *
 * WHY THIS EXISTS: `fs.writeFile` opens with O_TRUNC and then writes, which is
 * two steps, not one. Two writers racing on the same path — two Fury servers
 * sharing a `process.cwd()`, or one server plus a stray dev instance — can
 * interleave as:
 *
 *   A: open(w) → truncate to 0
 *   B: open(w) → truncate to 0
 *   A: write 247 bytes
 *   B: write 217 bytes        ← overwrites only the first 217
 *
 * leaving a 247-byte file: a complete JSON document with the tail of a longer
 * one glued to the end. `JSON.parse` then fails with "Unexpected non-whitespace
 * character after JSON at position N" — observed on `.claude-ui-state/state.json`.
 * A reader can also catch a plain single-writer truncation mid-write and see a
 * torn file.
 *
 * A rename is atomic on POSIX and replaces atomically on Windows (MoveFileEx),
 * so a reader sees either the whole old file or the whole new one, never a
 * splice of both. The temp name carries the pid so two processes never collide
 * on the scratch file itself — the rename is the only contention point, and
 * that one is atomic.
 *
 * The EPERM/EACCES retry covers a Windows reader (or AV scanner) transiently
 * holding the destination open; POSIX renames over an open file just succeed, so
 * the retry is effectively Windows-only.
 *
 * Consolidated from three copies that had drifted apart: the sync original in
 * lib/codeSearchConfig.ts (P20 — `.mcp.json` torn by two concurrent migrations),
 * the async twin in lib/mcpApprove.ts, and the non-atomic writes in the two
 * `.claude-ui-state` persisters that produced the corruption above.
 */
import { writeFileSync, renameSync, rmSync } from 'fs';
import { writeFile, rename, rm } from 'fs/promises';

const MAX_RENAME_RETRIES = 10;

let atomicTmpCounter = 0;
function tmpPathFor(path: string): string {
  return `${path}.fury-${process.pid}-${atomicTmpCounter++}.tmp`;
}

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * Atomically replace `path` with `data`. The parent directory must exist.
 *
 * The retry here is a BOUNDED busy-loop with NO backoff (unlike the async twin
 * below, which awaits a delay): this function is synchronous, so a delay could
 * only be a blocking sleep that stalls the event loop — worse than retrying.
 * Capped at 10 immediate attempts, and POSIX never reaches the retry at all.
 */
export function atomicWriteFileSync(path: string, data: string): void {
  const tmp = tmpPathFor(path);
  writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (isTransientRenameError(err) && i < MAX_RENAME_RETRIES) continue;
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  }
}

/**
 * Atomically replace `path` with `data`. The parent directory must exist.
 *
 * Being async, this one can actually wait between attempts — linear backoff, so
 * a contended destination gets progressively more room instead of burning the
 * retry budget in a few milliseconds.
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmp = tmpPathFor(path);
  await writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (isTransientRenameError(err) && i < MAX_RENAME_RETRIES) {
        await new Promise(r => setTimeout(r, 5 * (i + 1)));
        continue;
      }
      await rm(tmp, { force: true }).catch(() => { /* best effort */ });
      throw err;
    }
  }
}
