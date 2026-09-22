/**
 * Pure, dependency-free path helpers shared by the Files tab client and its
 * server routes. Kept separate from lib/fileTree.ts (which imports `fs`) so the
 * client bundle never pulls Node's filesystem module, and so the logic here can
 * be unit-tested directly.
 */

/** Normalize an OS-native path to forward slashes for prefix comparison. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * True if any changed path in `fileStatuses` lives inside `dirPath`.
 *
 * Under lazy tree loading a directory's descendants are usually NOT in memory,
 * so the folder "has changes" dot can no longer be derived from loaded children.
 * `fileStatuses` already contains every changed path (absolute) from
 * `git status` / `svn status`, so a prefix test over its keys answers the same
 * question without needing the subtree loaded — and works for collapsed folders.
 *
 * The trailing separator on the prefix is what keeps `/a/b` from matching a
 * sibling like `/a/bc/x`: we compare against `/a/b/`, not `/a/b`.
 */
export function dirHasChange(
  dirPath: string,
  fileStatuses: Record<string, unknown> | null | undefined,
): boolean {
  if (!fileStatuses) return false;
  const norm = toPosix(dirPath);
  const prefix = norm.endsWith('/') ? norm : norm + '/';
  for (const p in fileStatuses) {
    if (toPosix(p).startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Filename match rule for the Files-tab search box: case-insensitive prefix on
 * the basename. Mirrors the pre-lazy-load client filter so search semantics are
 * unchanged after the move to a server-side walk.
 */
export function matchesSearch(name: string, query: string): boolean {
  return name.toLowerCase().startsWith(query.toLowerCase());
}
