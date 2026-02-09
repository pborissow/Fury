import { NextRequest, NextResponse } from 'next/server';
import { unlink, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { sessionManager } from '@/lib/sessionManager';
import { projectPathToSlug } from '@/lib/utils';

export const runtime = 'nodejs';

/**
 * DELETE /api/session?sessionId=...&project=...
 *
 * Deletes a Claude CLI session. This is separate from /api/claude because
 * that route handles the real-time streaming conversation flow (SSE), while
 * this route handles session lifecycle management (filesystem cleanup).
 *
 * Steps:
 * 1. Kills the process if it's live in Fury's sessionManager
 * 2. Removes the session JSONL from ~/.claude/projects/<slug>/
 * 3. Removes matching entries from ~/.claude/history.jsonl
 */
export async function DELETE(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  const project = request.nextUrl.searchParams.get('project');

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const results: string[] = [];

  // 1. Kill the process if Fury is managing it
  try {
    sessionManager.killSession(sessionId);
    results.push('Killed active process');
  } catch {
    // Not managed by Fury — that's fine
  }

  // 2. Delete the session JSONL file
  if (project) {
    const slug = projectPathToSlug(project);
    const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
    try {
      await unlink(jsonlPath);
      results.push('Deleted session JSONL');
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[DeleteSession] Failed to delete JSONL:', err);
      }
    }
  }

  // 3. Remove matching entries from history.jsonl
  const historyPath = join(homedir(), '.claude', 'history.jsonl');
  try {
    const content = await readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n');
    const filtered = lines.filter(line => {
      try {
        const entry = JSON.parse(line);
        return entry.sessionId !== sessionId;
      } catch {
        return true; // Keep unparseable lines
      }
    });

    if (filtered.length < lines.length) {
      await writeFile(historyPath, filtered.join('\n') + '\n', 'utf-8');
      results.push(`Removed ${lines.length - filtered.length} history entries`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error('[DeleteSession] Failed to update history.jsonl:', err);
    }
  }

  return NextResponse.json({ success: true, results });
}
