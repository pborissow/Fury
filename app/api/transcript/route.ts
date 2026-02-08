import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const runtime = 'nodejs';

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * Convert an absolute project path to the slug used in ~/.claude/projects/
 * e.g. /Users/peter/myproject -> -Users-peter-myproject
 */
function projectPathToSlug(projectPath: string): string {
  // Replace colons, forward slashes, and backslashes with hyphens
  // e.g. U:\petya\Documents -> U--petya-Documents (matches Claude's slug format)
  // e.g. /Users/peter/myproject -> -Users-peter-myproject
  return projectPath.replace(/[:\\/]/g, '-');
}

/**
 * Check if a user message content string is internal/meta and should be skipped
 */
function isInternalContent(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command') ||
    trimmed.startsWith('<system-reminder>') ||
    trimmed === ''
  );
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const project = searchParams.get('project');

    if (!sessionId || !project) {
      return NextResponse.json(
        { error: 'sessionId and project are required' },
        { status: 400 }
      );
    }

    // Sanitize sessionId to prevent path traversal
    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');

    const slug = projectPathToSlug(project);
    const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sanitizedSessionId}.jsonl`);

    let content: string;
    try {
      content = await fs.readFile(jsonlPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json(
          { error: 'Transcript not found', messages: [] },
          { status: 404 }
        );
      }
      throw error;
    }

    const messages: TranscriptMessage[] = [];
    const lines = content.split('\n').filter(line => line.trim());

    // Buffer the latest assistant message per turn.
    // Claude Code logs every streaming update (stop_reason: null) as a
    // separate JSONL entry. We only want the last (most complete) assistant
    // entry before the next user message.
    let pendingAssistant: TranscriptMessage | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Skip non-message types
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;

        // Skip meta messages
        if (entry.isMeta) continue;

        const msg = entry.message;
        if (!msg) continue;

        if (entry.type === 'user') {
          // Flush any buffered assistant message before this user message
          if (pendingAssistant) {
            messages.push(pendingAssistant);
            pendingAssistant = null;
          }

          // User messages: content is a string (direct message) or array (tool results)
          if (typeof msg.content === 'string') {
            if (isInternalContent(msg.content)) continue;
            messages.push({
              role: 'user',
              content: msg.content,
              timestamp: entry.timestamp,
            });
          }
          // Skip array content (tool_result entries) - not useful for display
        } else if (entry.type === 'assistant') {
          if (!Array.isArray(msg.content)) continue;

          // Concatenate text blocks, skip tool_use, thinking, etc.
          const textParts: string[] = [];
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
          }

          if (textParts.length === 0) continue;

          const fullText = textParts.join('\n\n');
          if (!fullText.trim()) continue;

          // Buffer instead of pushing — later entries for the same turn
          // will overwrite this with more complete content
          pendingAssistant = {
            role: 'assistant',
            content: fullText,
            timestamp: entry.timestamp,
          };
        }
      } catch {
        // Skip unparseable lines
      }
    }

    // Flush the last buffered assistant message
    if (pendingAssistant) {
      messages.push(pendingAssistant);
    }

    return NextResponse.json({ messages });
  } catch (error) {
    console.error('[Transcript API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load transcript' },
      { status: 500 }
    );
  }
}
