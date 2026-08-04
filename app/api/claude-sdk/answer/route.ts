import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { settingsPersistence } from '@/lib/settingsPersistence';

export const runtime = 'nodejs';

/**
 * Answering a parked AskUserQuestion only means anything on the SDK backend.
 * The CLI path can't hold a tool call open at all: /api/claude auto-errors the
 * tool, sessionManager kills the process, and ChatTab re-injects the answer as a
 * fresh prose prompt. There is no promise here to resolve, so accepting an
 * answer would report success and resolve nothing.
 */
async function sdkEnabled(): Promise<boolean> {
  return (await settingsPersistence.loadSettings()).sdkSessionsEnabled !== false;
}

/** Fury mints session ids client-side as UUIDv4 (ChatTab.generateUUID). Validate
 *  before touching the manager — same rationale as /api/claude-sdk/model. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/claude-sdk/answer  — PROTOTYPE
 *
 * Resolve the question a session is parked on, in place, in the same turn.
 *
 *   { sessionId, toolUseID, answers: { [questionText]: string }, annotations? }
 *   { sessionId, toolUseID, skip: true }
 *
 * `answers` is keyed by QUESTION TEXT with multi-select values comma-joined —
 * that is AskUserQuestionOutput's own contract, not a Fury convention.
 *
 * `toolUseID` is the SDK's id for the parked tool call and MUST match the
 * pending one. A stale dialog (left open from a previous turn, or a second tab)
 * must not answer the current question — resolveAsk returns false on mismatch
 * and we surface 409 rather than pretending it landed.
 */
export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { sessionId, toolUseID, answers, annotations, skip } = (body ?? {}) as {
      sessionId?: unknown;
      toolUseID?: unknown;
      answers?: unknown;
      annotations?: unknown;
      skip?: unknown;
    };

    if (typeof sessionId !== 'string' || !sessionId) {
      return Response.json({ error: 'Session ID is required' }, { status: 400 });
    }
    if (!UUID_RE.test(sessionId)) {
      return Response.json({ error: 'Invalid session ID' }, { status: 400 });
    }
    if (typeof toolUseID !== 'string' || !toolUseID) {
      return Response.json({ error: 'toolUseID is required' }, { status: 400 });
    }
    if (!(await sdkEnabled())) {
      // Distinct from the "no pending question" 409 below (F6): here the answer never
      // had a chance to land, so the client must RESTORE the dialog rather than treat
      // it as settled and strand the parked turn.
      return Response.json(
        { error: 'Answering a question requires SDK sessions to be enabled', code: 'sdk_disabled' },
        { status: 409 },
      );
    }

    // Skip is a REAL signal, not a no-op: it denies the tool so the model learns
    // the user declined and can respond gracefully, in the same turn.
    if (skip === true) {
      const ok = sdkSessionManager.resolveAsk(sessionId, toolUseID, { skip: true });
      return ok
        ? Response.json({ ok: true, skipped: true })
        : Response.json({ error: 'No matching pending question', code: 'no_pending' }, { status: 409 });
    }

    // Enforce the value shape rather than trusting the client: a non-string
    // value would reach the model as JSON garbage inside the tool result.
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return Response.json({ error: 'answers must be an object' }, { status: 400 });
    }
    const entries = Object.entries(answers as Record<string, unknown>);
    if (entries.length === 0) {
      return Response.json({ error: 'answers must not be empty' }, { status: 400 });
    }
    if (!entries.every(([, v]) => typeof v === 'string')) {
      return Response.json({ error: 'answers values must be strings' }, { status: 400 });
    }

    const ok = sdkSessionManager.resolveAsk(sessionId, toolUseID, {
      answers: Object.fromEntries(entries) as Record<string, string>,
      ...(annotations && typeof annotations === 'object' && !Array.isArray(annotations)
        ? { annotations: annotations as Record<string, unknown> }
        : {}),
    });

    // 409, not 404: the session is likely alive and fine — this specific
    // question just isn't the one parked (already answered, or superseded). The
    // 'no_pending' code tells the client NOT to restore (correctly settled).
    return ok
      ? Response.json({ ok: true })
      : Response.json({ error: 'No matching pending question', code: 'no_pending' }, { status: 409 });
  } catch (error) {
    console.error('[api/claude-sdk/answer] failed:', error);
    return Response.json({ error: 'Failed to answer question' }, { status: 500 });
  }
}
