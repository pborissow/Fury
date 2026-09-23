import { NextRequest } from 'next/server';
import { writeHeapSnapshot } from 'v8';
import { statSync } from 'fs';
import { join } from 'path';
import { furyLogsDir } from '@/lib/furyHome';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/diagnostics/heap-snapshot
 *
 * Writes a V8 heap snapshot of the RUNNING process to ~/.fury/logs/. This is
 * the tool that actually names a leak: open the .heapsnapshot in Chrome
 * DevTools (Memory -> Load), sort by Retained Size, and the top retainer is the
 * answer. Two snapshots taken hours apart can be compared directly
 * (Comparison view) to show exactly which objects accumulated in between.
 *
 * POST rather than GET, and never automatic, because it is EXPENSIVE:
 *  - It stops the world for the duration (seconds on a multi-GB heap).
 *  - It writes a file roughly the size of the heap — a 1GB heap makes a ~1GB
 *    file. Check disk before running it repeatedly.
 * Doing this on a request path is deliberate: it avoids restarting the server,
 * which would destroy the accumulated state that makes the snapshot worth
 * taking in the first place.
 *
 * Body (optional): { "label": "before-big-run" } to tag the filename.
 */
export async function POST(request: NextRequest) {
  let label = '';
  try {
    const body = await request.json();
    if (body && typeof body.label === 'string') {
      label = body.label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
    }
  } catch {
    // no body is fine
  }

  const before = process.memoryUsage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `heap-${stamp}${label ? '-' + label : ''}.heapsnapshot`;

  let filePath: string;
  const startedAt = Date.now();
  try {
    filePath = writeHeapSnapshot(join(furyLogsDir(), name));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to write heap snapshot' },
      { status: 500 },
    );
  }

  let fileMb: number | null = null;
  try {
    fileMb = Math.round((statSync(filePath).size / 1024 / 1024) * 10) / 10;
  } catch {
    // snapshot written but not stat-able; not fatal
  }

  return Response.json({
    ok: true,
    file: filePath,
    fileMb,
    tookMs: Date.now() - startedAt,
    heapUsedMbAtCapture: Math.round((before.heapUsed / 1024 / 1024) * 10) / 10,
    hint: 'Open in Chrome DevTools > Memory > Load. Take a second one later and use Comparison view.',
  });
}
