import { NextResponse } from 'next/server';
import { liveSessionScanner } from '@/lib/liveSessionScanner';
import { sessionManager } from '@/lib/sessionManager';

export const runtime = 'nodejs';

/**
 * Returns the session IDs of currently live Claude sessions, merged from
 * two sources:
 *   1. PID-file scan (covers external `claude` CLIs not managed by Fury)
 *   2. SessionManager's own active sessions (covers Fury-spawned processes,
 *      whose PID file under v2.1.144+ carries a per-spawn sessionId that
 *      doesn't match the conversation id the UI looks up)
 *
 * Ongoing updates are pushed via SSE through /api/events.
 */
export async function GET() {
  let scanned: string[] = [];
  try {
    scanned = await liveSessionScanner.scanNow();
  } catch { /* scanner failure shouldn't drop manager-managed sessions */ }

  const merged = new Set<string>(scanned);
  try {
    for (const id of sessionManager.getActiveSessionIds()) merged.add(id);
  } catch { /* manager unavailable (e.g. HMR race) — keep scanner output */ }

  return NextResponse.json({ liveSessionIds: [...merged] });
}
