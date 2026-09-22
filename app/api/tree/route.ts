import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { getBranch } from '@/lib/vcsServer';
import { IGNORED_ITEMS, MAX_TREE_NODES, DEFAULT_MAX_DEPTH } from '@/lib/fileTree';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

interface WalkBudget {
  remaining: number;
  truncated: boolean;
}

async function buildFileTree(
  dirPath: string,
  maxDepth: number,
  currentDepth: number,
  budget: WalkBudget,
): Promise<FileTreeNode[]> {
  if (currentDepth >= maxDepth || budget.remaining <= 0) {
    return [];
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      // Skip ignored items
      if (IGNORED_ITEMS.has(entry.name)) {
        continue;
      }

      if (budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      budget.remaining--;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const children = await buildFileTree(fullPath, maxDepth, currentDepth + 1, budget);
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        });
      } else {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
        });
      }
    }

    // Sort: directories first, then files, both alphabetically
    nodes.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === 'directory' ? -1 : 1;
    });

    return nodes;
  } catch (error) {
    // Permission-denied directories (e.g. "System Volume Information" on a
    // Windows drive root) are expected; don't spam the log with stack traces.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'EPERM' && code !== 'EACCES') {
      console.error(`Error reading directory ${dirPath}:`, error);
    }
    return [];
  }
}

// VCS status codes: M=modified, A=added, D=deleted, R=renamed, ?=untracked, C=conflict, !=missing
type VcsFileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'C' | '!';
type VcsType = 'git' | 'svn';

interface VcsResult {
  vcs: VcsType;
  statuses: Record<string, VcsFileStatus>;
  branch: string | null;
}

async function detectVcs(dirPath: string): Promise<VcsType | null> {
  // Check for .git first (more common), then .svn
  try {
    await fs.stat(path.join(dirPath, '.git'));
    return 'git';
  } catch {
    // Not git
  }
  try {
    await fs.stat(path.join(dirPath, '.svn'));
    return 'svn';
  } catch {
    // Not svn
  }
  return null;
}

async function getGitStatus(dirPath: string): Promise<Record<string, VcsFileStatus>> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '-uall'], { cwd: dirPath, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({});
        return;
      }

      const statuses: Record<string, VcsFileStatus> = {};
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        // Porcelain format: XY filename
        // X = index status, Y = working tree status
        const match = line.match(/^(.)(.)\s?(.+)$/);
        if (!match) continue;
        const [, indexStatus, workTreeStatus, rawPath] = match;
        let filePath = rawPath;

        // Handle renamed files: "R  old -> new"
        if (filePath.includes(' -> ')) {
          filePath = filePath.split(' -> ')[1];
        }

        // Remove any quotes from filenames with special characters
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }

        const absPath = path.join(dirPath, filePath);

        // Determine the most relevant status
        if (indexStatus === '?' || workTreeStatus === '?') {
          statuses[absPath] = '?';
        } else if (indexStatus === 'A' || workTreeStatus === 'A') {
          statuses[absPath] = 'A';
        } else if (indexStatus === 'D' || workTreeStatus === 'D') {
          statuses[absPath] = 'D';
        } else if (indexStatus === 'R' || workTreeStatus === 'R') {
          statuses[absPath] = 'R';
        } else if (indexStatus === 'M' || workTreeStatus === 'M') {
          statuses[absPath] = 'M';
        }
      }

      resolve(statuses);
    });
  });
}

async function getSvnStatus(dirPath: string): Promise<Record<string, VcsFileStatus>> {
  return new Promise((resolve) => {
    execFile('svn', ['status'], { cwd: dirPath, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({});
        return;
      }

      const statuses: Record<string, VcsFileStatus> = {};
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        // SVN status format: "X       filename"
        // First column is the status character
        const statusChar = line[0];
        const filePath = line.slice(8).trim();
        if (!filePath) continue;

        const absPath = path.join(dirPath, filePath);

        switch (statusChar) {
          case 'M': statuses[absPath] = 'M'; break;
          case 'A': statuses[absPath] = 'A'; break;
          case 'D': statuses[absPath] = 'D'; break;
          case '?': statuses[absPath] = '?'; break;
          case '!': statuses[absPath] = '!'; break;
          case 'C': statuses[absPath] = 'C'; break;
          case 'R': statuses[absPath] = 'R'; break;
        }
      }

      resolve(statuses);
    });
  });
}

async function getVcsStatus(dirPath: string): Promise<VcsResult | null> {
  const vcs = await detectVcs(dirPath);
  if (!vcs) return null;

  const [statuses, branch] = await Promise.all([
    vcs === 'git' ? getGitStatus(dirPath) : getSvnStatus(dirPath),
    getBranch(dirPath, vcs),
  ]);

  return { vcs, statuses, branch };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dirPath = searchParams.get('path');

    if (!dirPath) {
      return NextResponse.json(
        { error: 'Directory path is required' },
        { status: 400 }
      );
    }

    // Check if directory exists
    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        return NextResponse.json(
          { error: 'Path is not a directory' },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'Directory does not exist' },
        { status: 404 }
      );
    }

    // Status-only mode: a commit or branch switch leaves the tree untouched but
    // makes every badge stale. Re-walking the whole tree to learn that would be
    // pure waste, so skip it and return just the VCS fields.
    if (searchParams.get('statusOnly') === '1') {
      const vcsOnly = await getVcsStatus(dirPath);
      return NextResponse.json({
        success: true,
        root: dirPath,
        vcs: vcsOnly?.vcs || null,
        branch: vcsOnly?.branch || null,
        fileStatuses: vcsOnly?.statuses || null,
      });
    }

    const depthParam = searchParams.get('depth');
    const maxDepth = depthParam ? Math.max(1, Math.min(50, parseInt(depthParam, 10) || DEFAULT_MAX_DEPTH)) : DEFAULT_MAX_DEPTH;

    const budget: WalkBudget = { remaining: MAX_TREE_NODES, truncated: false };
    const [tree, vcsResult] = await Promise.all([
      buildFileTree(dirPath, maxDepth, 0, budget),
      getVcsStatus(dirPath),
    ]);

    if (budget.truncated) {
      console.warn(`/api/tree: ${dirPath} exceeded ${MAX_TREE_NODES} entries; tree truncated`);
    }

    return NextResponse.json({
      success: true,
      tree,
      root: dirPath,
      truncated: budget.truncated,
      vcs: vcsResult?.vcs || null,
      branch: vcsResult?.branch || null,
      fileStatuses: vcsResult?.statuses || null,
    });
  } catch (error) {
    console.error('Error in /api/tree:', error);
    return NextResponse.json(
      { error: 'Failed to read directory tree' },
      { status: 500 }
    );
  }
}
