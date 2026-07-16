import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { settingsPersistence } from '@/lib/settingsPersistence';

export const runtime = 'nodejs';

/**
 * Model selection only means anything on the SDK backend. /api/claude dispatches
 * on this same setting; when it's off, turns are served by the CLI sessionManager,
 * which knows nothing about sdkSessionManager's per-session model. Accepting a
 * choice there would report success and then silently serve the default forever.
 */
async function sdkEnabled(): Promise<boolean> {
  return (await settingsPersistence.loadSettings()).sdkSessionsEnabled !== false;
}

/** Fury mints session ids client-side as UUIDv4 (ChatTab.generateUUID). Validate
 *  before touching the manager: setModel() creates a session entry on miss, so an
 *  unvalidated id would let any string add a permanent entry to the in-memory map. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/claude-sdk/model?sessionId=...  — PROTOTYPE
 *
 * The selectable model catalog for a session, plus the session's current
 * override (undefined = CLI default).
 *
 * `live: false` means the list came from cache because the session has no open
 * query to ask — the picker surfaces that rather than presenting it as fact.
 */
export async function GET(req: NextRequest) {
  try {
    const sessionId = req.nextUrl.searchParams.get('sessionId');
    if (!sessionId) return Response.json({ error: 'Session ID is required' }, { status: 400 });
    if (!UUID_RE.test(sessionId)) return Response.json({ error: 'Invalid session ID' }, { status: 400 });
    if (!(await sdkEnabled())) {
      return Response.json({ error: 'Model selection requires SDK sessions to be enabled' }, { status: 409 });
    }

    const result = await sdkSessionManager.listModels(sessionId);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/claude-sdk/model  — PROTOTYPE
 *
 * Change a session's model via the SDK control protocol. Applies to the live
 * process without a restart; conversation history and the warm subprocess are
 * preserved.
 *
 * Body: { sessionId: string, model?: string }   — omit `model` for the default.
 * Returns: { applied: 'live' | 'pending' }      — 'pending' = recorded, will
 *          take effect when the session's query opens.
 */
export async function POST(req: NextRequest) {
  let body: { sessionId?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sessionId, model } = body;
  if (typeof sessionId !== 'string' || !sessionId) {
    return Response.json({ error: 'Session ID is required' }, { status: 400 });
  }
  if (!UUID_RE.test(sessionId)) return Response.json({ error: 'Invalid session ID' }, { status: 400 });
  if (model != null && typeof model !== 'string') {
    return Response.json({ error: 'Model must be a string' }, { status: 400 });
  }
  if (!(await sdkEnabled())) {
    return Response.json({ error: 'Model selection requires SDK sessions to be enabled' }, { status: 409 });
  }

  try {
    const result = await sdkSessionManager.setModel(sessionId, model ?? undefined);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    // The realistic failure here is the SDK rejecting the id — unrecognized, or
    // blocked by enforceAvailableModels. That's the caller's input, so 400.
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 400 });
  }
}
