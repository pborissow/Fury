import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

export const runtime = 'nodejs';

/**
 * POST /api/claude-sdk/interrupt  — PROTOTYPE
 *
 * Gracefully interrupt the in-flight turn via the SDK's control protocol,
 * keeping the session process alive — unlike the shipping path which kills the
 * whole process tree.
 *
 * Body: { sessionId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();
    if (!sessionId) return Response.json({ error: 'Session ID is required' }, { status: 400 });

    await sdkSessionManager.interrupt(sessionId);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
