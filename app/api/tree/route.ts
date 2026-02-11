import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

// List of directories and files to ignore
const IGNORED_ITEMS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  '.DS_Store',
  'coverage',
  '.turbo',
  '.cache',
]);

async function buildFileTree(dirPath: string, maxDepth: number = 5, currentDepth: number = 0): Promise<FileTreeNode[]> {
  if (currentDepth >= maxDepth) {
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

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const children = await buildFileTree(fullPath, maxDepth, currentDepth + 1);
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
    console.error(`Error reading directory ${dirPath}:`, error);
    return [];
  }
}

// Git status codes: M=modified, A=added, D=deleted, R=renamed, ?=untracked
type GitFileStatus = 'M' | 'A' | 'D' | 'R' | '?';

async function getGitStatus(dirPath: string): Promise<Record<string, GitFileStatus> | null> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '-uall'], { cwd: dirPath, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // Not a git repo or git not available
        resolve(null);
        return;
      }

      const statuses: Record<string, GitFileStatus> = {};
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        // Porcelain format: XY filename
        // X = index status, Y = working tree status
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        let filePath = line.slice(3);

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

    const [tree, gitStatus] = await Promise.all([
      buildFileTree(dirPath),
      getGitStatus(dirPath),
    ]);

    return NextResponse.json({
      success: true,
      tree,
      root: dirPath,
      gitStatus,
    });
  } catch (error) {
    console.error('Error in /api/tree:', error);
    return NextResponse.json(
      { error: 'Failed to read directory tree' },
      { status: 500 }
    );
  }
}
