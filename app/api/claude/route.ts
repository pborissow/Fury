import { NextRequest } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { settingsPersistence } from '@/lib/settingsPersistence';

export const runtime = 'nodejs';

/**
 * POST /api/claude
 *
 * Sends a message to a Claude session. Returns immediately after queuing the
 * message — all stream data is delivered via SSE through /api/events.
 *
 * When `sdkSessionsEnabled` is on (default in the sdk-session-prototype
 * branch), the turn is routed to the persistent @anthropic-ai/claude-agent-sdk
 * manager (lib/sdkSessionManager.ts) instead of the one-shot `claude --print`
 * manager. Both emit the SAME eventBus events, so the frontend and /api/events
 * SSE stream are identical either way — the frontend keeps calling /api/claude
 * and doesn't need to know which backend served the turn.
 *
 * Body: { prompt: string, sessionId: string, projectPath?: string }
 * Response: { ok: true, backend: 'sdk' | 'cli' }
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

    // Default to the SDK path if the setting can't be read, matching the
    // branch default (fail toward the behavior under test here).
    let useSdk = true;
    try {
      useSdk = (await settingsPersistence.loadSettings()).sdkSessionsEnabled !== false;
    } catch (err) {
      console.error('[Claude API] settings load failed, defaulting to SDK path:', err);
    }

    // Fire-and-forget: the manager runs in the background, emitting stream
    // events and health updates via the eventBus.
    if (useSdk) {
      sdkSessionManager.sendMessage(sessionId, prompt, projectPath).catch(error => {
        console.error('[Claude API] SDK sendMessage failed:', error);
      });
    } else {
      sessionManager.processMessage(sessionId, prompt, [], projectPath).catch(error => {
        console.error('[Claude API] processMessage failed:', error);
      });
    }

    return Response.json({ ok: true, backend: useSdk ? 'sdk' : 'cli' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
