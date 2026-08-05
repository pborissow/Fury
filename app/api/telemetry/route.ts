/**
 * Sink for UI telemetry. The browser (lib/clientTelemetry.ts) batches structured
 * events here; we replay each into the shared server log (lib/logger.ts) tagged
 * source:'ui'. This is the second half of the "close the loop" plumbing: after
 * this route runs, a single daily JSONL holds UI and server lines for the same
 * session, interleaved by timestamp.
 *
 * Accepts a plain JSON body AND sendBeacon payloads (the browser fires one on
 * pagehide, which arrives as text/plain) — we parse the raw text either way.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ingestUiEntry, log, RawUiEntry } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A single batch is a handful of UI decisions, not a firehose. Cap hard so a
// misbehaving or hostile client can't flood the log in one request.
const MAX_EVENTS_PER_BATCH = 200;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    // Read as text so both application/json and sendBeacon's text/plain work.
    const text = await request.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  const events: unknown = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) {
    return NextResponse.json({ ok: false, error: 'expected { events: [] }' }, { status: 400 });
  }

  let accepted = 0;
  for (const e of events.slice(0, MAX_EVENTS_PER_BATCH)) {
    try {
      ingestUiEntry(e as RawUiEntry);
      accepted++;
    } catch {
      // ingestUiEntry is already defensive; swallow anything that slips through
      // so one bad entry can't drop the rest of the batch.
    }
  }

  if (events.length > MAX_EVENTS_PER_BATCH) {
    log.warn('telemetry', 'batch truncated', {
      data: { received: events.length, cap: MAX_EVENTS_PER_BATCH },
    });
  }

  return NextResponse.json({ ok: true, accepted });
}
