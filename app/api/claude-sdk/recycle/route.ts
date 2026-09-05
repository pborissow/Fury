import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

export const runtime = 'nodejs';

/**
 * POST /api/claude-sdk/recycle
 *
 * Tear down a session's warm process so the NEXT turn respawns under the current
 * provider env (used by the usage-limit dialog's Bedrock failover — a warm
 * process keeps talking to the old provider otherwise). Also clears the model
 * pin, since an Anthropic wire id is invalid on a Bedrock process.
 *
 * Body: { sessionId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();
    if (!sessionId) return Response.json({ error: 'Session ID is required' }, { status: 400 });

    await sdkSessionManager.recycleForProviderSwitch(sessionId);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
