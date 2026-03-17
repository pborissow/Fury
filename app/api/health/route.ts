import { NextRequest, NextResponse } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';

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

    return NextResponse.json({
      sessionId,
      ...health
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
