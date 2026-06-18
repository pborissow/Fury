import { NextRequest } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { loadArchivedSessions } from '@/lib/transcriptArchiver';

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
    const url = new URL(req.url);
    const limitParam = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const offsetParam = Number.parseInt(url.searchParams.get('offset') || '', 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 25;
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

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

      // Sort by timestamp (most recent first), drop sessions with no meaningful messages
      const allEntriesFlat = Array.from(sessionBestEntry.entries())
        .filter(([, entry]) => !isSkippableDisplay(entry.display))
        .map(([key, entry]) => ({
          ...entry,
          messageCount: sessionMessageCount.get(key) || 0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      // Merge archived sessions from SQLite (surfaces sessions that survived
      // in the DB after Claude deleted the JSONL + history entries)
      try {
        const archivedSessions = await loadArchivedSessions();
        const existingIds = new Set(allEntriesFlat.map(e => e.sessionId).filter(Boolean));

        // Build a metadata lookup from archived sessions
        const metadataMap = new Map<string, Record<string, unknown>>();
        for (const archived of archivedSessions) {
          if (archived.metadata) {
            metadataMap.set(archived.session_id, archived.metadata);
          }
        }

        // Enrich existing entries with metadata from the DB
        for (const entry of allEntriesFlat) {
          if (entry.sessionId && metadataMap.has(entry.sessionId)) {
            (entry as any).metadata = metadataMap.get(entry.sessionId);
          }
        }

        for (const archived of archivedSessions) {
          if (existingIds.has(archived.session_id)) continue;
          if (isSkippableDisplay(archived.display)) continue;
          allEntriesFlat.push({
            display: archived.display,
            timestamp: archived.updated_at,
            project: archived.project,
            sessionId: archived.session_id,
            messageCount: archived.message_count,
            ...(archived.metadata ? { metadata: archived.metadata } : {}),
          } as any);
        }

        // Re-sort after merging
        allEntriesFlat.sort((a, b) => b.timestamp - a.timestamp);
      } catch (archiveErr) {
        console.error('[History] Failed to load archived sessions:', archiveErr);
      }

      const total = allEntriesFlat.length;
      const entries = allEntriesFlat.slice(offset, offset + limit);
      const hasMore = offset + entries.length < total;

      return new Response(JSON.stringify({ entries, hasMore, total }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // If file doesn't exist or can't be read, return empty array
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Response(JSON.stringify({ entries: [], hasMore: false, total: 0 }), {
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
