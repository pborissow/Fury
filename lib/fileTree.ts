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
 * Upper bound on how many entries a single bounded tree WALK may visit.
 *
 * NOTE: the /api/tree listing is no longer node-capped — it returns one
 * directory level per request (lazy loading), so depth is naturally 1 and there
 * is nothing to truncate (see
 * docs/ticket-filetree-lazy-load-and-watcher-dedup.md). This constant now bounds
 * only the one walk that genuinely recurses: the server-side filename search
 * (/api/tree/search). A directory bigger than this (a drive root, a large
 * network share, a monorepo with generated output) is the failure mode it
 * guards against — the walk would otherwise take tens of seconds.
 */
export const MAX_TREE_NODES = 20000;
