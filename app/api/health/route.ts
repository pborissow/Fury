import { NextRequest, NextResponse } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const health = sessionManager.getSessionHealth(sessionId);
    // Persistent SDK-manager turns aren't tracked by the CLI sessionManager;
    // OR in its processing state so the UI's restore/poll paths see a live SDK
    // session as processing (keeps the dots + stream alive).
    const isProcessing = health.isProcessing || sdkSessionManager.isSessionProcessing(sessionId);
    // The single-source-of-truth liveness projection (design doc). PULL and PUSH ship
    // the SAME object, computed purely from the SDK session (step 4: no CLI-manager OR
    // fed into the projection — `mainTurnActive` is the session's own `s.isProcessing`,
    // the authoritative main-turn state, so PULL and PUSH can't diverge on a route-
    // local input). Null for a CLI-only session with no SDK record — client falls back
    // to the legacy `isProcessing` field below.
    const liveness = sdkSessionManager.getLiveness(sessionId);
    // In-flight background work keeps the session live (dots) even with an idle main
    // turn (docs/ticket-live-badge-dark-during-background-subagent.md). Read it OFF
    // the projection so computeBackgroundActive runs ONCE per request (it mutates a
    // wedged set + logs); only fall back to a direct call for a CLI-only session.
    const backgroundActive = liveness ? liveness.backgroundAgentic : sdkSessionManager.isBackgroundActive(sessionId);
    // The current turn's start timestamp — mirrors the session:health SSE payload's
    // legacy field (raw buffer start, present even when idle). Distinct from the
    // projection's null-when-not-main-turn `liveness.startedAt` anchor.
    const startedAt = sdkSessionManager.getTurnStartedAt(sessionId);

    return NextResponse.json({
      sessionId,
      ...health,
      isProcessing,
      backgroundActive,
      startedAt,
      liveness,
    });
  } catch (error) {
    console.error('[Health Check API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to check session health' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, action } = body;

    if (!sessionId || !action) {
      return NextResponse.json(
        { error: 'Session ID and action are required' },
        { status: 400 }
      );
    }

    if (action === 'stop') {
      await sessionManager.stopProcessing(sessionId);
      return NextResponse.json({ success: true, message: 'Processing stopped' });
    }

    if (action === 'kill') {
      await sessionManager.killSession(sessionId);
      return NextResponse.json({ success: true, message: 'Session killed' });
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    console.error('[Health Check API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to perform action' },
      { status: 500 }
    );
  }
}
