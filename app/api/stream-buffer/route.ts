import { NextRequest } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';

export const runtime = 'nodejs';

/**
 * GET /api/stream-buffer?sessionId=...
 *
 * Returns the current stream buffer for a session. The buffer accumulates all
 * SSE events server-side so the frontend can restore stream state when a user
 * switches back to a session that is still processing.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'sessionId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const health = sessionManager.getSessionHealth(sessionId);
  const buffer = sessionManager.getStreamBuffer(sessionId);

  if (!buffer) {
    return Response.json({
      hasBuffer: false,
      isProcessing: health.isProcessing,
    });
  }

  return Response.json({
    hasBuffer: true,
    isProcessing: health.isProcessing,
    userPrompt: buffer.userPrompt,
    accumulatedText: buffer.accumulatedText,
    events: buffer.events,
    isActive: buffer.isActive,
    startedAt: buffer.startedAt,
  });
}
