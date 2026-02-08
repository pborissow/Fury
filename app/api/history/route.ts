import { NextRequest } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export const runtime = 'nodejs';

interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
  pastedContents?: Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');

    try {
      const content = await readFile(historyPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      // Parse each line as JSON, most recent first
      const allEntries: HistoryEntry[] = lines
        .map(line => {
          try {
            return JSON.parse(line) as HistoryEntry;
          } catch (e) {
            console.error('Failed to parse history line:', e);
            return null;
          }
        })
        .filter((entry): entry is HistoryEntry => entry !== null)
        .reverse(); // Most recent first

      // Messages that aren't useful as session summaries
      const isSkippableDisplay = (display: string): boolean => {
        const trimmed = display.trim().toLowerCase();
        return trimmed === 'exit' || trimmed.startsWith('/') || trimmed.startsWith('--');
      };

      // Count total messages per session and find best display entry
      const sessionMessageCount = new Map<string, number>();
      const sessionBestEntry = new Map<string, HistoryEntry>();

      for (const entry of allEntries) {
        const key = entry.sessionId || `no-session-${entry.timestamp}`;

        // Count every entry
        sessionMessageCount.set(key, (sessionMessageCount.get(key) || 0) + 1);

        const existing = sessionBestEntry.get(key);
        if (!existing) {
          sessionBestEntry.set(key, entry);
        } else if (isSkippableDisplay(existing.display) && !isSkippableDisplay(entry.display)) {
          sessionBestEntry.set(key, { ...entry, timestamp: existing.timestamp });
        }
      }

      // Sort by timestamp (most recent first), drop sessions with no meaningful messages, and limit
      const entries = Array.from(sessionBestEntry.entries())
        .filter(([, entry]) => !isSkippableDisplay(entry.display))
        .map(([key, entry]) => ({
          ...entry,
          messageCount: sessionMessageCount.get(key) || 0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);

      return new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // If file doesn't exist or can't be read, return empty array
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');

    try {
      // Clear the history file by writing an empty string
      await writeFile(historyPath, '', 'utf-8');

      return new Response(JSON.stringify({ success: true, message: 'History cleared' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // If file doesn't exist, that's fine - nothing to clear
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Response(JSON.stringify({ success: true, message: 'No history to clear' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
