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

    // A parked question blocks the turn mid-tool. sendMessage REJECTS in that
    // case, but the dispatch below is fire-and-forget — the rejection would
    // become a server-side console line while the client is told {ok:true},
    // then waits forever for SSE that can never arrive (sendMessage throws
    // before startQuery, so no health event ever fires). Spinner forever,
    // message silently gone.
    //
    // So the check has to happen HERE, where a status code can still be
    // returned. ChatTab's send already renders a non-ok `error` and clears the
    // spinner, which is the "reject with a clear error" the design called for.
    // sendMessage keeps its own guard as defense in depth (another client, a
    // race) — this is the one that can actually talk to the user.
    if (useSdk && sdkSessionManager.getPendingAsk(sessionId)) {
      return Response.json(
        { error: 'Claude is waiting for an answer to its question. Answer or dismiss it first.' },
        { status: 409 },
      );
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
