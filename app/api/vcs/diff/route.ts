import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { detectVcs, run } from '@/lib/vcsServer';

// GET /api/vcs/diff?root=<absDir>&path=<absFile>&side=staged|unstaged[&orig=<relPath>]
//
// Returns the two sides of a file diff:
//   { left, right, leftLabel, rightLabel } | { binary: true } | { tooLarge: true }
//
// git staged:   HEAD:<orig ?? rel>  vs  :<rel> (index)
// git unstaged: :<rel> (index)      vs  working tree
//   Index-as-base (rather than HEAD) means a partially staged file shows only
//   its unstaged delta; when nothing is staged the index equals HEAD anyway.
// svn (side ignored): BASE vs working copy

const MAX_FILE_SIZE = 1024 * 1024; // 1MB — mirrors /api/file

function isBinary(text: string): boolean {
  return text.includes('\0');
}

async function readWorktree(filePath: string): Promise<string | null> {
  // Deleted files are expected — return empty content
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) return null; // tooLarge
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const root = searchParams.get('root');
    const filePath = searchParams.get('path');
    const side = searchParams.get('side') === 'staged' ? 'staged' : 'unstaged';
    const orig = searchParams.get('orig');

    if (!root || !filePath) {
      return NextResponse.json({ error: 'root and path are required' }, { status: 400 });
    }

    try {
      const stats = await fs.stat(root);
      if (!stats.isDirectory()) {
        return NextResponse.json({ error: 'root is not a directory' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'root does not exist' }, { status: 404 });
    }

    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return NextResponse.json({ error: 'path is outside root' }, { status: 400 });
    }

    const vcs = await detectVcs(root);
    if (!vcs) {
      return NextResponse.json({ error: 'Not a VCS working copy' }, { status: 400 });
    }

    let left = '';
    let right: string | null = '';
    let leftLabel = '';
    let rightLabel = '';

    if (vcs === 'git') {
      if (side === 'staged') {
        const head = await run('git', ['show', `HEAD:${orig || rel}`], root);
        left = head.code === 0 ? head.stdout : ''; // error → newly added
        const index = await run('git', ['show', `:${rel}`], root);
        right = index.code === 0 ? index.stdout : ''; // error → deleted from index
        leftLabel = 'HEAD';
        rightLabel = 'Index';
      } else {
        const index = await run('git', ['show', `:${rel}`], root);
        left = index.code === 0 ? index.stdout : ''; // error → untracked
        right = await readWorktree(filePath);
        leftLabel = 'Index';
        rightLabel = 'Working Tree';
      }
    } else {
      const base = await run('svn', ['cat', '-r', 'BASE', '--', filePath], root);
      left = base.code === 0 ? base.stdout : ''; // error → added/untracked
      right = await readWorktree(filePath);
      leftLabel = 'BASE';
      rightLabel = 'Working Copy';
    }

    if (right === null || left.length > MAX_FILE_SIZE) {
      return NextResponse.json({ tooLarge: true });
    }
    if (isBinary(left) || isBinary(right)) {
      return NextResponse.json({ binary: true });
    }

    return NextResponse.json({ left, right, leftLabel, rightLabel });
  } catch (error) {
    console.error('Error in /api/vcs/diff:', error);
    return NextResponse.json({ error: 'Failed to compute diff' }, { status: 500 });
  }
}
