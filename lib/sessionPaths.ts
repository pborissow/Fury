import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { projectPathToSlug } from './utils';

export interface JsonlLocation {
  /** Project slug directory containing the JSONL */
  dir: string;
  /** Canonical cwd recorded by Claude CLI inside the JSONL — use this for
   *  spawn so a subsequent --resume slugifies to the same dir */
  canonicalCwd: string;
}

/**
 * Read the first valid JSONL entry's `cwd` field. Reads only the first 64 KB
 * to avoid pulling a multi-MB transcript synchronously just to fetch metadata.
 * Returns null if no parseable entry with a `cwd` is found in the head.
 */
export function readCwdFromJsonl(jsonlPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, bytesRead).toString('utf-8');
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.cwd === 'string' && entry.cwd) return entry.cwd;
      } catch { /* incomplete or non-JSON line — keep looking */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Find the project slug directory that contains a session JSONL.
 * Tried in order:
 *   1. The slug derived from `projectPath`
 *   2. The slug derived from `realpath(projectPath)` (catches symlinks)
 *   3. A scan of every `~/.claude/projects/<slug>/` for `<sessionId>.jsonl`
 *      (catches Windows subst-mapped drives — e.g. history.jsonl says
 *      `C:\Users\petya\…` but the JSONL was filed under `U:\petya\…` because
 *      Claude CLI normalized cwd to the subst form. realpath does not resolve
 *      subst on Windows.)
 *
 * Returns both the directory and the canonical cwd from the JSONL itself
 * so callers can pass the path Claude CLI's slug derivation will round-trip
 * to the same dir.
 */
export function findSessionJsonlDir(sessionId: string, projectPath: string): JsonlLocation | null {
  const base = join(homedir(), '.claude', 'projects');
  const slug = projectPathToSlug(projectPath);

  const tryDir = (dir: string, fallbackCwd: string): JsonlLocation | null => {
    const file = join(dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) return null;
    return { dir, canonicalCwd: readCwdFromJsonl(file) || fallbackCwd };
  };

  const primary = tryDir(join(base, slug), projectPath);
  if (primary) return primary;

  try {
    const resolved = realpathSync(projectPath);
    if (resolved !== projectPath) {
      const altSlug = projectPathToSlug(resolved);
      if (altSlug !== slug) {
        const alt = tryDir(join(base, altSlug), resolved);
        if (alt) return alt;
      }
    }
  } catch { /* ignore */ }

  try {
    for (const dir of readdirSync(base)) {
      const found = tryDir(join(base, dir), projectPath);
      if (found) return found;
    }
  } catch { /* ignore */ }

  return null;
}
