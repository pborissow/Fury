import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

export const runtime = 'nodejs';

/**
 * POST /api/claude-sdk/rewind  — PROTOTYPE
 *
 * Native conversation + file rewind via the SDK (`resume` + `resumeSessionAt`
 * and `rewindFiles`), replacing Fury's custom transcript surgery.
 *
 * Body: { sessionId: string, messageUuid: string, projectPath?: string }
 *   messageUuid is an SDKAssistantMessage.uuid from the transcript.
 */
export async function POST(req: NextRequest) {
  try {
    const { sessionId, messageUuid, projectPath } = await req.json();
    if (!sessionId) return Response.json({ error: 'Session ID is required' }, { status: 400 });
    if (!messageUuid) return Response.json({ error: 'messageUuid is required' }, { status: 400 });

    const result = await sdkSessionManager.rewind(sessionId, messageUuid, projectPath);
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
