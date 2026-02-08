import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dirPath = searchParams.get('path');

  try {
    // Start with home directory if no path specified
    const targetPath = dirPath || os.homedir();

    // Security: Resolve the path to prevent directory traversal attacks
    const resolvedPath = path.resolve(targetPath);

    // Read directory contents
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

    // Filter and format the results
    const directories = entries
      .filter(entry => entry.isDirectory())
      .filter(entry => !entry.name.startsWith('.')) // Hide hidden directories by default
      .map(entry => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
        isDirectory: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Get parent directory info
    const parentPath = path.dirname(resolvedPath);
    const canGoUp = resolvedPath !== '/';

    return NextResponse.json({
      currentPath: resolvedPath,
      parentPath: canGoUp ? parentPath : null,
      directories,
      homeDir: os.homedir(),
    });
  } catch (error) {
    console.error('Error reading directory:', error);
    return NextResponse.json(
      { error: 'Failed to read directory' },
      { status: 500 }
    );
  }
}
