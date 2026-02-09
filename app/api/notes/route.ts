import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { projectPathToSlug } from '@/lib/utils';

const NOTES_DIR = path.join(os.homedir(), '.claude-session-notes');

// Ensure notes directory exists
async function ensureNotesDirectory() {
  try {
    await fs.mkdir(NOTES_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create notes directory:', error);
  }
}

function getNotesPath(projectPath: string): string {
  const slug = projectPathToSlug(projectPath);
  // Sanitize to prevent directory traversal
  const sanitized = slug.replace(/[^a-zA-Z0-9-_]/g, '');
  return path.join(NOTES_DIR, `${sanitized}.md`);
}

// GET /api/notes?projectPath=xxx
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectPath = searchParams.get('projectPath');

    if (!projectPath) {
      return NextResponse.json(
        { error: 'Project path is required' },
        { status: 400 }
      );
    }

    await ensureNotesDirectory();
    const notesPath = getNotesPath(projectPath);

    try {
      const content = await fs.readFile(notesPath, 'utf-8');
      return NextResponse.json({
        success: true,
        notes: content,
      });
    } catch (error) {
      // If file doesn't exist, return empty notes
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json({
          success: true,
          notes: '',
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error loading notes:', error);
    return NextResponse.json(
      { error: 'Failed to load notes' },
      { status: 500 }
    );
  }
}

// POST /api/notes
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { projectPath, notes } = body;

    if (!projectPath) {
      return NextResponse.json(
        { error: 'Project path is required' },
        { status: 400 }
      );
    }

    if (typeof notes !== 'string') {
      return NextResponse.json(
        { error: 'Notes must be a string' },
        { status: 400 }
      );
    }

    await ensureNotesDirectory();
    const notesPath = getNotesPath(projectPath);

    await fs.writeFile(notesPath, notes, 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Notes saved successfully',
    });
  } catch (error) {
    console.error('Error saving notes:', error);
    return NextResponse.json(
      { error: 'Failed to save notes' },
      { status: 500 }
    );
  }
}

// DELETE /api/notes?projectPath=xxx
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectPath = searchParams.get('projectPath');

    if (!projectPath) {
      return NextResponse.json(
        { error: 'Project path is required' },
        { status: 400 }
      );
    }

    const notesPath = getNotesPath(projectPath);

    try {
      await fs.unlink(notesPath);
      return NextResponse.json({
        success: true,
        message: 'Notes deleted successfully',
      });
    } catch (error) {
      // If file doesn't exist, consider it a success
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json({
          success: true,
          message: 'Notes file not found',
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error deleting notes:', error);
    return NextResponse.json(
      { error: 'Failed to delete notes' },
      { status: 500 }
    );
  }
}
