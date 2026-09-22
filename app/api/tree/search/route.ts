import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { IGNORED_ITEMS, MAX_TREE_NODES } from '@/lib/fileTree';
import { matchesSearch } from '@/lib/treePaths';
import type { FileTreeNode } from '@/app/api/tree/route';

/**
 * Server-side filename search for the Files tab.
 *
 * Under lazy tree loading the client no longer holds the whole tree, so it can't
 * filter it in memory — searching only loaded folders would silently miss files
 * in unexpanded ones. This walks the tree on the server instead, matching by the
 * same case-insensitive basename-prefix rule the client used to apply.
 *
 * The walk is bounded by MAX_TREE_NODES (the same guard the recursive tree walk
 * once used, now living HERE where a cap is actually appropriate): on a
 * pathological root it stops early and reports `truncated: true` so search stays
 * cheap while tree browsing itself remains uncapped.
 */

// Cap the number of returned matches too — a broad prefix on a huge repo could
// otherwise match tens of thousands of files and bloat the response.
const MAX_MATCHES = 500;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const root = searchParams.get('path');
  const query = (searchParams.get('q') || '').trim();

  if (!root) {
    return NextResponse.json({ error: 'Directory path is required' }, { status: 400 });
  }

  if (!query) {
    return NextResponse.json({ success: true, matches: [], truncated: false });
  }

  try {
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Directory does not exist' }, { status: 404 });
  }

  const matches: FileTreeNode[] = [];
  let visited = 0;
  let truncated = false;

  // Iterative walk (a deep tree can nest past a comfortable recursion). No depth
  // cap: the lazy tree browse is itself uncapped in depth, so capping search
  // would make deeply-nested files silently unsearchable. Termination is bounded
  // by MAX_TREE_NODES instead (and readdir doesn't follow symlinks — only real
  // subdirectories are pushed — so there's no cycle to run away on).
  const stack: string[] = [root];

  walk: while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied / vanished mid-walk — skip, same as the tree walk.
      continue;
    }

    for (const entry of entries) {
      if (IGNORED_ITEMS.has(entry.name)) continue;

      visited++;
      if (visited > MAX_TREE_NODES) {
        truncated = true;
        break walk;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (matchesSearch(entry.name, query)) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break walk;
        }
        matches.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }
  }

  // Directories first would be meaningless (only files match); sort by name so
  // results are stable and mirror the old alphabetical client filter.
  matches.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ success: true, matches, truncated });
}
