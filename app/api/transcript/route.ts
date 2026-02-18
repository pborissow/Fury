import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { realpath } from 'fs/promises';
import { projectPathToSlug } from '@/lib/utils';

export const runtime = 'nodejs';

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * Check if a user message content string is internal/meta and should be skipped.
 * This covers XML system tags and Claude CLI slash commands.
 */
function isInternalContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === '') return true;
  if (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command') ||
    trimmed.startsWith('<system-reminder>')
  ) return true;
  // Skip Claude CLI slash commands
  if (/^\/[a-z]/.test(trimmed)) return true;
  return false;
}

/**
 * When no JSONL transcript exists (pre-persistence sessions), extract
 * whatever user prompts were saved in history.jsonl for this session.
 */
async function getHistoryPrompts(sessionId: string): Promise<TranscriptMessage[]> {
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const content = await fs.readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n');
    const messages: TranscriptMessage[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId !== sessionId) continue;
        if (!entry.display || !entry.display.trim()) continue;
        // Skip slash commands and bare "exit"
        const trimmed = entry.display.trim();
        if (/^\/[a-z]/i.test(trimmed)) continue;
        if (trimmed.toLowerCase() === 'exit') continue;

        messages.push({
          role: 'user',
          content: entry.display,
          timestamp: typeof entry.timestamp === 'number'
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp,
        });
      } catch {
        // Skip unparseable lines
      }
    }

    return messages;
  } catch {
    return [];
  }
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

    const projectsBase = join(homedir(), '.claude', 'projects');
    const slug = projectPathToSlug(project);
    const jsonlPath = join(projectsBase, slug, `${sanitizedSessionId}.jsonl`);

    let content: string;
    try {
      content = await fs.readFile(jsonlPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The project path may be a symlink or mapped drive that resolves to a
        // different real path. Try the resolved path before giving up.
        try {
          const resolvedProject = await realpath(project);
          if (resolvedProject !== project) {
            const altSlug = projectPathToSlug(resolvedProject);
            if (altSlug !== slug) {
              const altPath = join(projectsBase, altSlug, `${sanitizedSessionId}.jsonl`);
              content = await fs.readFile(altPath, 'utf-8');
            } else {
              throw error; // same slug, won't help
            }
          } else {
            // realpath didn't change it — try scanning project dirs for the file
            const dirs = await fs.readdir(projectsBase);
            let found = false;
            for (const dir of dirs) {
              try {
                const candidate = join(projectsBase, dir, `${sanitizedSessionId}.jsonl`);
                content = await fs.readFile(candidate, 'utf-8');
                found = true;
                break;
              } catch { /* try next */ }
            }
            if (!found) throw error;
          }
        } catch {
          // All attempts failed — fall back to user prompts from history.jsonl
          const historyMessages = await getHistoryPrompts(sanitizedSessionId);
          return NextResponse.json({
            messages: historyMessages,
            partial: true,
          });
        }
      } else {
        throw error;
      }
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
