import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/** Validate that the path is an existing directory (not a file, not a system path). */
async function validateProjectPath(projectPath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(projectPath);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return 'Path is not a directory';
    return null;
  } catch {
    return 'Directory does not exist';
  }
}

/**
 * GET /api/claude-md?path=/some/project
 * Reads the CLAUDE.md file at the given project path.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectPath = searchParams.get('path');

    if (!projectPath) {
      return NextResponse.json({ error: 'Project path is required' }, { status: 400 });
    }

    const pathError = await validateProjectPath(projectPath);
    if (pathError) {
      return NextResponse.json({ error: pathError }, { status: 400 });
    }

    const filePath = path.join(path.resolve(projectPath), 'CLAUDE.md');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return NextResponse.json({ content, exists: true });
    } catch {
      return NextResponse.json({ content: '', exists: false });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/claude-md
 * Appends content to CLAUDE.md at the given project path.
 * Body: { path: string, content: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: projectPath, content } = body;

    if (!projectPath || !content) {
      return NextResponse.json(
        { error: 'Project path and content are required' },
        { status: 400 },
      );
    }

    const pathError = await validateProjectPath(projectPath);
    if (pathError) {
      return NextResponse.json({ error: pathError }, { status: 400 });
    }

    const filePath = path.join(path.resolve(projectPath), 'CLAUDE.md');

    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist yet — will be created
    }

    const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '';
    await fs.writeFile(filePath, existing + separator + content + '\n', 'utf-8');

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
