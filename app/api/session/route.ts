import { NextRequest, NextResponse } from 'next/server';
import { unlink, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { sessionManager } from '@/lib/sessionManager';
import { projectPathToSlug } from '@/lib/utils';
import { deleteArchivedSession, invalidateArchive } from '@/lib/transcriptArchiver';
import { isInternalContent } from '@/lib/transcriptParser';

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

  // Sanitized ID for filesystem paths (prevents path traversal).
  // The raw sessionId is still needed for sessionManager (keyed by original ID)
  // and history.jsonl comparison (stores original IDs from Claude CLI).
  const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  const results: string[] = [];

  // 1. Kill the process if Fury is managing it (uses raw sessionId — sessions
  //    are keyed by their original UUID, which is already safe for in-memory lookup)
  try {
    sessionManager.killSession(sessionId);
    results.push('Killed active process');
  } catch {
    // Not managed by Fury — that's fine
  }

  // 2. Remove from SQLite archive FIRST — before deleting the JSONL file,
  //    so the history watcher can't re-archive from the still-existing file.
  await deleteArchivedSession(sanitizedSessionId).catch(err =>
    console.error('[DeleteSession] Failed to delete from archive:', err)
  );

  // 3. Delete the session JSONL file
  if (project) {
    const slug = projectPathToSlug(project);
    const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sanitizedSessionId}.jsonl`);
    try {
      await unlink(jsonlPath);
      results.push('Deleted session JSONL');
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[DeleteSession] Failed to delete JSONL:', err);
      }
    }
  }

  // 4. Remove matching entries from history.jsonl (uses raw sessionId —
  //    history entries store the original UUID from Claude CLI)
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

/**
 * PATCH /api/session - Rewind a session to before a given user turn index.
 * Truncates the JSONL file, keeping only entries before the Nth user message turn.
 */
export async function PATCH(request: NextRequest) {
  try {
    const { sessionId, project, turnIndex, removeLastHistoryEntry } = await request.json();

    if (!sessionId || !project || turnIndex == null) {
      return NextResponse.json(
        { error: 'sessionId, project, and turnIndex are required' },
        { status: 400 }
      );
    }

    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
    const slug = projectPathToSlug(project);
    const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sanitizedSessionId}.jsonl`);

    const content = await readFile(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Count visible user turns and find the JSONL line where the target turn starts
    let userTurnCount = 0;
    let cutLineIndex = lines.length;

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'user' || entry.isMeta) continue;

        const msg = entry.message;
        if (!msg || typeof msg.content !== 'string') continue;
        if (isInternalContent(msg.content)) continue;

        if (userTurnCount === turnIndex) {
          cutLineIndex = i;
          break;
        }
        userTurnCount++;
      } catch {
        // Skip unparseable lines
      }
    }

    if (cutLineIndex >= lines.length) {
      return NextResponse.json(
        { error: 'Turn index not found' },
        { status: 400 }
      );
    }

    const truncatedLines = lines.slice(0, cutLineIndex);
    await writeFile(jsonlPath, truncatedLines.join('\n') + '\n', 'utf-8');

    // Invalidate SQLite archive so the next transcript GET re-archives the truncated version
    await invalidateArchive(sanitizedSessionId).catch(err =>
      console.error('[Session/Rewind] Failed to invalidate archive:', err)
    );

    console.log(`[Session/Rewind] Truncated session ${sanitizedSessionId} at turn ${turnIndex} (removed ${lines.length - cutLineIndex} lines)`);

    // Optionally remove the most recent history.jsonl entry for this session
    // (used when "Conversation + Code" rewind sends an undo prompt that pollutes history)
    if (removeLastHistoryEntry) {
      const historyPath = join(homedir(), '.claude', 'history.jsonl');
      try {
        const histContent = await readFile(historyPath, 'utf-8');
        const histLines = histContent.trim().split('\n');
        // Find the last line matching this sessionId and remove it
        let lastMatchIdx = -1;
        for (let i = histLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(histLines[i]);
            if (entry.sessionId === sessionId) {
              lastMatchIdx = i;
              break;
            }
          } catch { /* skip */ }
        }
        if (lastMatchIdx >= 0) {
          histLines.splice(lastMatchIdx, 1);
          await writeFile(historyPath, histLines.join('\n') + '\n', 'utf-8');
          console.log(`[Session/Rewind] Removed latest history entry for session ${sanitizedSessionId}`);
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          console.error('[Session/Rewind] Failed to clean up history:', err);
        }
      }
    }

    return NextResponse.json({ success: true, linesRemoved: lines.length - cutLineIndex });
  } catch (error) {
    console.error('[Session/Rewind] Error:', error);
    return NextResponse.json(
      { error: 'Failed to rewind session' },
      { status: 500 }
    );
  }
}
