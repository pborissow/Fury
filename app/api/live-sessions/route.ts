import { NextResponse } from 'next/server';
import { liveSessionScanner } from '@/lib/liveSessionScanner';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { computeLiveSessionIds } from '@/lib/liveSessions';

export const runtime = 'nodejs';

/**
 * Returns the session IDs of currently live Claude sessions.
 *
 * "Live" = actively processing (submit → final turn), NOT merely "has a warm
 * process". This must use the SAME computeLiveSessionIds() logic as the SSE
 * stream in /api/events, otherwise a persistent-but-idle SDK session would show
 * live on initial page load (the PID scanner sees its warm process) and only
 * correct itself after the first SSE tick.
 */
export async function GET() {
  let scanned: string[] = [];
  try {
    scanned = await liveSessionScanner.scanNow();
  } catch { /* scanner failure shouldn't drop manager-managed sessions */ }

  const safe = (fn: () => string[]): string[] => {
    try { return fn(); } catch { return []; }
  };

  const liveSessionIds = computeLiveSessionIds({
    scannerIds: scanned,
    shippingActiveIds: safe(() => sessionManager.getActiveSessionIds()),
    sdkManagedIds: safe(() => sdkSessionManager.getManagedSessionIds()),
    sdkActiveIds: safe(() => sdkSessionManager.getActiveSessionIds()),
  });

  return NextResponse.json({ liveSessionIds });
}
