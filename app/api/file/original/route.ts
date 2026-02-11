import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

type VcsType = 'git' | 'svn';

async function detectVcs(filePath: string): Promise<{ vcs: VcsType; root: string } | null> {
  // Walk up directories looking for .git or .svn
  let dir = path.dirname(filePath);
  const parsedRoot = path.parse(dir).root;

  while (dir !== parsedRoot) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return { vcs: 'git', root: dir };
    } catch {
      // Not git
    }
    try {
      await fs.stat(path.join(dir, '.svn'));
      return { vcs: 'svn', root: dir };
    } catch {
      // Not svn
    }
    dir = path.dirname(dir);
  }
  return null;
}

function getGitOriginal(filePath: string, repoRoot: string): Promise<string | null> {
  // Get the relative path from the repo root
  const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');

  return new Promise((resolve) => {
    execFile('git', ['show', `HEAD:${relativePath}`], { cwd: repoRoot, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // File doesn't exist in HEAD (new file)
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

function getSvnOriginal(filePath: string, repoRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('svn', ['cat', '-r', 'BASE', filePath], { cwd: repoRoot, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // File doesn't exist in BASE (new file)
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json(
        { error: 'File path is required' },
        { status: 400 }
      );
    }

    const vcsInfo = await detectVcs(filePath);
    if (!vcsInfo) {
      return NextResponse.json(
        { error: 'File is not in a git or svn repository' },
        { status: 400 }
      );
    }

    const original = vcsInfo.vcs === 'git'
      ? await getGitOriginal(filePath, vcsInfo.root)
      : await getSvnOriginal(filePath, vcsInfo.root);

    if (original === null) {
      return NextResponse.json(
        { error: 'No base version found (new file)' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      content: original,
      vcs: vcsInfo.vcs,
      path: filePath,
    });
  } catch (error) {
    console.error('Error in /api/file/original:', error);
    return NextResponse.json(
      { error: 'Failed to read original file' },
      { status: 500 }
    );
  }
}
