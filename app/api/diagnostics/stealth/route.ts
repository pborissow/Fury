import { NextRequest } from 'next/server';
import { stealthSessions, StealthAskError } from '@/lib/stealthSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/diagnostics/stealth
 *
 * Status of Fury's hidden background sessions (lib/stealthSessions.ts): one row
 * per consumer: alive/busy/queued, turns, context size, spawns, lifetime spend.
 * Never includes prompts or answers. This is the ONLY place a stealth session's
 * id is deliberately exposed, so an operator can tell what's running.
 *
 * POST /api/diagnostics/stealth   { prompt: string }
 *
 * Runs ONE ask on the reserved `diag-probe` consumer: Haiku, NO tools, no MCP
 * servers. That makes it inert, and it's still a real stealth session through the
 * real registry. It exists so the e2e hiding regression
 * (tests/e2e/stealth-sessions-hidden.spec.ts) can drive the contract every
 * consumer inherits without depending on any particular consumer. Dev-only
 * unless FURY_STEALTH_PROBE=1, because it spends (a fraction of a cent of) tokens.
 */
export async function GET() {
  return Response.json({ sessions: stealthSessions.list() });
}

const PROBE_NAME = 'diag-probe';
const MAX_PROMPT = 2_000;

export async function POST(req: NextRequest) {
  const enabled = process.env.NODE_ENV !== 'production' || process.env.FURY_STEALTH_PROBE === '1';
  if (!enabled) return Response.json({ error: 'Stealth probe disabled' }, { status: 403 });

  let prompt: unknown;
  try { ({ prompt } = await req.json()); } catch { /* fall through */ }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Response.json({ error: 'prompt is required' }, { status: 400 });
  }

  try {
    const s = await stealthSessions.acquire({
      name: PROBE_NAME,
      label: 'Diagnostics probe',
      model: 'haiku',
      systemPrompt: 'You answer health-check pings from the Fury app. Keep replies to a few words.',
      askTimeoutMs: 60_000,
      idleKillMs: 2 * 60_000,
    });
    const r = await s.ask(prompt.slice(0, MAX_PROMPT), { signal: req.signal });
    return Response.json({
      name: PROBE_NAME,
      text: r.text,
      sessionId: r.sessionId,
      costUsd: r.costUsd,
      usage: r.usage,
      durationMs: r.durationMs,
    });
  } catch (err) {
    const code = err instanceof StealthAskError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message, code }, { status: code === 'timeout' ? 504 : 500 });
  }
}
