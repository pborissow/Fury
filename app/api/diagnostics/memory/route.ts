import { NextRequest } from 'next/server';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { sessionManager } from '@/lib/sessionManager';
import { treeWatchers } from '@/lib/treeWatchers';
import { fileWatchers } from '@/lib/fileWatchers';
import { mcpCache } from '@/lib/mcpCache';
import { eventBus } from '@/lib/eventBus';
import { subagentUsageCacheStats } from '@/lib/subagentUsage';
import { sessionPathsCacheStats } from '@/lib/sessionPaths';
import { archiverLockStats } from '@/lib/transcriptArchiver';
import { codemoggerStats } from '@/lib/codemoggerServer';
import { buildManagerReport, collectSample } from '@/lib/memoryReport';
import { memorySampler, summarizeGrowth } from '@/lib/memorySampler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/diagnostics/memory
 *
 * Retention telemetry for the slow heap growth that ends in "Ineffective
 * mark-compacts near heap limit" after a few days of uptime.
 *
 * Hitting this endpoint also STARTS the background sampler (idempotent), which
 * appends a compact sample to ~/.fury/logs/memory-<date>.jsonl every minute.
 * That is the point: a single reading cannot tell "big" from "growing", and the
 * samples survive on disk even if the run ends in an OOM.
 *
 * Query params:
 *   ?top=N       how many heaviest sessions to detail (default 15, 0 to skip)
 *   ?growth=1    include rate-of-change over the retained sample window
 *   ?sample=1    force an extra sample right now
 *
 * Reading the output:
 *   - growth.spacesMbPerHour.old_space climbing => an object-graph leak;
 *     something holds references. Take a heap snapshot.
 *   - growth.spacesMbPerHour.large_object_space climbing while old_space is
 *     flat => big-string/array churn and fragmentation (e.g. re-parsing whole
 *     transcripts) rather than a reference leak.
 *   - growth.countersDelta names which structures actually grew; a counter that
 *     only ever increases is a leak with an address.
 *   - sessions.*.expiredBufferCount > 0 => buffers past their TTL never
 *     reclaimed, because expiry only runs when something polls that session.
 *
 * Strictly read-only with respect to app state: it never calls
 * getStreamBuffer(), whose TTL check would drop the very buffer it inspects.
 */
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const topN = Math.max(0, Math.min(100, Number.parseInt(sp.get('top') || '', 10) || 15));

  const collect = () => collectSample({
    sdkSessionManager,
    sessionManager,
    fileWatchers,
    mcpCache,
    treeWatchers,
    eventBus: eventBus as unknown as { listenerCount?: (e: string) => number },
    subagentUsageCacheStats,
    sessionPathsCacheStats,
    archiverLockStats,
    codemoggerStats,
  });

  // Idempotent: the first request after a (re)start begins sampling.
  memorySampler.start(collect);
  if (sp.get('sample') === '1') memorySampler.sampleNow();

  const now = collect();

  const body: Record<string, unknown> = {
    capturedAt: new Date(now.t).toISOString(),
    uptimeHours: Math.round((now.uptimeSec / 3600) * 100) / 100,
    process: {
      rssMb: now.rssMb,
      heapUsedMb: now.heapUsedMb,
      heapTotalMb: now.heapTotalMb,
      heapLimitMb: now.heapLimitMb,
      externalMb: now.externalMb,
      arrayBuffersMb: now.arrayBuffersMb,
      heapHeadroomMb: Math.round((now.heapLimitMb - now.heapUsedMb) * 10) / 10,
      // RSS far above heapTotal is native/code/fragmentation, not a JS leak.
      nonHeapMb: Math.round((now.rssMb - now.heapTotalMb - now.externalMb) * 10) / 10,
    },
    heapSpacesMb: now.spacesMb,
    counters: now.counters,
    sampler: memorySampler.stats(),
  };

  if (topN > 0) {
    body.sessions = {
      sdk: buildManagerReport('sdk', sdkSessionManager, topN),
      cli: buildManagerReport('cli', sessionManager, topN),
    };
  }

  if (sp.get('growth') === '1') {
    body.growth = summarizeGrowth(memorySampler.samples());
  }

  return Response.json(body);
}
