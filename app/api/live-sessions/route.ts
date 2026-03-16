import { NextResponse } from 'next/server';
import { liveSessionScanner } from '@/lib/liveSessionScanner';

export const runtime = 'nodejs';

/**
 * Returns the session IDs of currently live Claude sessions.
 * Delegates to the LiveSessionScanner singleton which handles
 * platform-specific process detection (PowerShell on Windows, pgrep+lsof on Unix).
 *
 * This endpoint is used for initial data fetch on page load.
 * Ongoing updates are pushed via SSE through /api/events.
 */
export async function GET() {
  try {
    const ids = await liveSessionScanner.scanNow();
    return NextResponse.json({ liveSessionIds: ids });
  } catch {
    return NextResponse.json({ liveSessionIds: [] });
  }
}
