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
    // In-flight background work keeps the session live (dots) even with an idle
    // main turn — see docs/ticket-live-badge-dark-during-background-subagent.md.
    const backgroundActive = sdkSessionManager.isBackgroundActive(sessionId);

    return NextResponse.json({
      sessionId,
      ...health,
      isProcessing,
      backgroundActive,
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
