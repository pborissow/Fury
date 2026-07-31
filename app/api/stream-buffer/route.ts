import { NextRequest } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

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
  // A turn served by the persistent SDK manager isn't tracked by the CLI
  // sessionManager, so fall back to its buffer. Without this the response is
  // `hasBuffer:false` for every SDK session, and ChatTab skips the branch that
  // strips the in-flight turn's partial assistant messages from the JSONL —
  // rendering intermediary bubbles above the bouncing dots — and loses stream
  // restore (text/events/timer) on switch-back.
  const buffer = sessionManager.getStreamBuffer(sessionId) ?? sdkSessionManager.getStreamBuffer(sessionId);
  // Likewise OR in its processing state — otherwise ChatTab's poll sees
  // isProcessing:false and clears transcriptLoading (no dots, no stream).
  const isProcessing = health.isProcessing || sdkSessionManager.isSessionProcessing(sessionId);
  // In-flight background work (a dispatched subagent) keeps the dots on even when
  // the main turn is idle — docs/ticket-live-badge-dark-during-background-subagent.md.
  const backgroundActive = sdkSessionManager.isBackgroundActive(sessionId);

  // A question the SDK session is parked on, awaiting this user. Server-held
  // state is the ONLY source of a pending question on the SDK path — the JSONL
  // replay that serves the CLI path can't answer one (it has no toolUseID), so
  // without this a browser refresh strands the turn: Claude waits forever on a
  // dialog that no longer exists on screen.
  //
  // Fetched independently of `buffer` and returned on BOTH branches on purpose.
  // This response whitelists its fields, so anything not named here is dropped —
  // and a pending question must survive even when the buffer is missing/expired.
  const pendingAsk = sdkSessionManager.getPendingAsk(sessionId);

  if (!buffer) {
    return Response.json({
      hasBuffer: false,
      isProcessing,
      backgroundActive,
      pendingAsk,
    });
  }

  return Response.json({
    hasBuffer: true,
    isProcessing,
    backgroundActive,
    userPrompt: buffer.userPrompt,
    accumulatedText: buffer.accumulatedText,
    events: buffer.events,
    isActive: buffer.isActive,
    startedAt: buffer.startedAt,
    pendingAsk,
  });
}
