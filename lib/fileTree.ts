import { promises as fs } from 'fs';
import path from 'path';

/** Directories and files never shown in the tree, and never counted or watched. */
export const IGNORED_ITEMS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.svn',
  'dist',
  'build',
  'out',
  '.DS_Store',
  'coverage',
  '.turbo',
  '.cache',
]);

/** True if any path segment is an ignored item. */
export function isIgnoredPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  return parts.some((part) => IGNORED_ITEMS.has(part));
}

/**
 * What a filesystem event means to the UI.
 *  - 'file' — a working-copy file changed; refetch the tree.
 *  - 'vcs'  — repository metadata changed (commit, stage, branch switch);
 *             the tree is unchanged but status badges are stale.
 *  - null   — uninteresting; drop it.
 */
export type ChangeKind = 'file' | 'vcs';

/**
 * Decides whether a change inside a .git directory should refresh status.
 *
 * Deliberately an exclusion list over a small set of noisy areas rather than an
 * allowlist of known files: that way unusual-but-meaningful state (MERGE_HEAD,
 * ORIG_HEAD, REBASE_HEAD, packed-refs) still refreshes, instead of silently
 * going stale because it wasn't enumerated.
 */
function isRelevantGitMeta(rest: string[]): boolean {
  if (rest.length === 0) return false; // the .git dir's own mtime — too noisy
  const [head] = rest;
  const last = rest[rest.length - 1];

  // Object writes and reflog appends happen constantly during a commit and
  // never change what `git status` reports on their own.
  if (head === 'objects' || head === 'logs') return false;
  // Lock files appear and vanish around the real write that follows.
  if (last.endsWith('.lock')) return false;
  // Written before the refs update; refreshing here would read a half-done commit.
  if (head === 'COMMIT_EDITMSG') return false;

  return true; // HEAD, index, refs/**, packed-refs, MERGE_HEAD, ...
}

/** Same idea for an svn working copy, whose state lives in .svn/wc.db. */
function isRelevantSvnMeta(rest: string[]): boolean {
  if (rest.length === 0) return false;
  const [head] = rest;
  const last = rest[rest.length - 1];

  if (head === 'tmp' || head === 'pristine') return false;
  if (last.endsWith('.lock') || last.endsWith('-journal') || last.endsWith('-wal')) return false;

  return true;
}

/**
 * Classifies a watcher event path (relative to the watched root).
 *
 * VCS metadata is checked before the generic ignore list, since '.git'/'.svn'
 * are themselves ignored items — without this ordering every commit would be
 * dropped, which is exactly the stale-badge bug this exists to fix.
 */
export function classifyChange(relPath: string): ChangeKind | null {
  const parts = relPath.split(/[\\/]/).filter(Boolean);

  const vcsIdx = parts.findIndex((p) => p === '.git' || p === '.svn');
  if (vcsIdx !== -1) {
    const rest = parts.slice(vcsIdx + 1);
    const relevant = parts[vcsIdx] === '.git' ? isRelevantGitMeta(rest) : isRelevantSvnMeta(rest);
    return relevant ? 'vcs' : null;
  }

  if (parts.some((p) => IGNORED_ITEMS.has(p))) return null;
  return 'file';
}

/**
 * Upper bound on the number of nodes a single /api/tree response may contain,
 * and the ceiling above which we refuse to attach a recursive file watcher.
 *
 * A directory bigger than this (a drive root, a large network share, a
 * monorepo with generated output) is the failure mode this guards against:
 * the walk takes tens of seconds, and a recursive watch on it means every
 * write anywhere underneath triggers another full walk.
 */
export const MAX_TREE_NODES = 20000;

/** Depth limit used when no explicit depth is requested. */
export const DEFAULT_MAX_DEPTH = 20;

export interface EntryCount {
  count: number;
  /** True if the walk stopped early because `limit` was passed. */
  exceeded: boolean;
}

/**
 * Counts the entries under `dirPath` that the tree walk would include, giving
 * up as soon as the total passes `limit`.
 *
 * This is deliberately bounded: it never visits more than ~`limit` entries, so
 * it stays cheap even when pointed at a whole volume. It applies the same
 * ignore rules and depth cap as buildFileTree, so the count reflects what would
 * actually be listed — without that, any project with a node_modules would
 * look oversized.
 *
 * Unreadable directories contribute 0 rather than throwing; a permission error
 * partway through shouldn't make a large tree look small enough to watch.
 */
export async function countTreeEntries(
  dirPath: string,
  limit: number = MAX_TREE_NODES,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<EntryCount> {
  let count = 0;
  // Iterative walk: a drive root can nest deeper than a comfortable recursion.
  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth >= maxDepth) continue;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied / vanished mid-walk — skip, same as the tree walk.
      continue;
    }

    for (const entry of entries) {
      if (IGNORED_ITEMS.has(entry.name)) continue;

      count++;
      if (count > limit) {
        return { count, exceeded: true };
      }

      if (entry.isDirectory()) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }

  return { count, exceeded: false };
}
