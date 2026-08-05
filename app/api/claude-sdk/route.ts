import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

export const runtime = 'nodejs';

/**
 * POST /api/claude-sdk  — PROTOTYPE
 *
 * Streaming-session counterpart to /api/claude. Sends a message to a
 * persistent SDK-backed session (opened on first use, reused thereafter).
 * Stream data is delivered via the existing /api/events SSE endpoint, exactly
 * like the shipping path.
 *
 * Body: { prompt: string, sessionId: string, projectPath?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { prompt, sessionId, projectPath } = await req.json();
    if (!prompt) return Response.json({ error: 'Prompt is required' }, { status: 400 });
    if (!sessionId) return Response.json({ error: 'Session ID is required' }, { status: 400 });

    sdkSessionManager.sendMessage(sessionId, prompt, projectPath).catch((error) => {
      console.error('[Claude SDK API] sendMessage failed:', error);
    });

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
