import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

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

    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return NextResponse.json(
          { error: 'Path is not a file' },
          { status: 400 }
        );
      }
      if (stats.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: 'File is too large to display (>1MB)' },
          { status: 413 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'File does not exist' },
        { status: 404 }
      );
    }

    const content = await fs.readFile(filePath, 'utf-8');

    return NextResponse.json({
      success: true,
      content,
      path: filePath,
    });
  } catch (error) {
    console.error('Error in /api/file:', error);
    return NextResponse.json(
      { error: 'Failed to read file' },
      { status: 500 }
    );
  }
}
