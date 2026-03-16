import { NextRequest } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';

export const runtime = 'nodejs';

/**
 * POST /api/claude
 *
 * Sends a message to a Claude CLI session. The request returns immediately
 * after queuing the message — all stream data is delivered via SSE through
 * the /api/events endpoint.
 *
 * Body: { prompt: string, sessionId: string, projectPath?: string }
 * Response: { ok: true }
 */
export async function POST(req: NextRequest) {
  try {
    const { prompt, sessionId, projectPath } = await req.json();

    if (!prompt) {
      return Response.json({ error: 'Prompt is required' }, { status: 400 });
    }

    if (!sessionId) {
      return Response.json({ error: 'Session ID is required' }, { status: 400 });
    }

    // Fire-and-forget: processMessage runs in the background, emitting
    // stream events and health updates via the eventBus.
    sessionManager.processMessage(sessionId, prompt, [], projectPath).catch(error => {
      console.error('[Claude API] processMessage failed:', error);
    });

    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
