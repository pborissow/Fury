import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

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

    const tree = await buildFileTree(dirPath);

    return NextResponse.json({
      success: true,
      tree,
      root: dirPath,
    });
  } catch (error) {
    console.error('Error in /api/tree:', error);
    return NextResponse.json(
      { error: 'Failed to read directory tree' },
      { status: 500 }
    );
  }
}
