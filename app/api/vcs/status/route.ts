import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { getStatus } from '@/lib/vcsServer';

// GET /api/vcs/status?path=<absDir>
// Returns the working-copy status split into staged/unstaged lists,
// or { vcs: null } when the directory is not a git/svn working copy.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dirPath = searchParams.get('path');

    if (!dirPath) {
      return NextResponse.json({ error: 'Directory path is required' }, { status: 400 });
    }

    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Directory does not exist' }, { status: 404 });
    }

    const status = await getStatus(dirPath);
    if (!status) {
      return NextResponse.json({ vcs: null });
    }
    return NextResponse.json(status);
  } catch (error) {
    console.error('Error in /api/vcs/status:', error);
    return NextResponse.json({ error: 'Failed to read VCS status' }, { status: 500 });
  }
}
