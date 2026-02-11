import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const isWindows = process.platform === 'win32';

async function getWindowsDrives(): Promise<string[]> {
  const checks = [];
  for (let i = 65; i <= 90; i++) {
    const driveLetter = String.fromCharCode(i);
    const drivePath = `${driveLetter}:\\`;
    checks.push(
      fs.access(drivePath).then(() => drivePath).catch(() => null)
    );
  }
  const results = await Promise.all(checks);
  return results.filter((d): d is string => d !== null);
}

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

    // Build directory list, handling symlinks properly
    const directories: Array<{
      name: string;
      path: string;
      isDirectory: true;
      isSymlink: boolean;
    }> = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Hide hidden entries

      const fullPath = path.join(resolvedPath, entry.name);
      const isSymlink = entry.isSymbolicLink();

      if (entry.isDirectory()) {
        directories.push({ name: entry.name, path: fullPath, isDirectory: true, isSymlink });
      } else if (isSymlink) {
        // Symlink that didn't report as directory — stat the target to check
        try {
          const stats = await fs.stat(fullPath);
          if (stats.isDirectory()) {
            directories.push({ name: entry.name, path: fullPath, isDirectory: true, isSymlink: true });
          }
        } catch {
          // Broken symlink or inaccessible target — skip
        }
      }
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));

    // Determine if we can go up — handle both Unix root and Windows drive roots
    const parentPath = path.dirname(resolvedPath);
    const isAtRoot = isWindows
      ? parentPath === resolvedPath // path.dirname('C:\') === 'C:\'
      : resolvedPath === '/';

    // Include available drives on Windows
    const drives = isWindows ? await getWindowsDrives() : undefined;

    return NextResponse.json({
      currentPath: resolvedPath,
      parentPath: isAtRoot ? null : parentPath,
      directories,
      homeDir: os.homedir(),
      ...(drives !== undefined && { drives }),
    });
  } catch (error) {
    console.error('Error reading directory:', error);
    return NextResponse.json(
      { error: 'Failed to read directory' },
      { status: 500 }
    );
  }
}
