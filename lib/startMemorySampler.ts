import { sdkSessionManager } from './sdkSessionManager';
import { sessionManager } from './sessionManager';
import { treeWatchers } from './treeWatchers';
import { fileWatchers } from './fileWatchers';
import { mcpCache } from './mcpCache';
import { eventBus } from './eventBus';
import { subagentUsageCacheStats } from './subagentUsage';
import { sessionPathsCacheStats } from './sessionPaths';
import { archiverLockStats } from './transcriptArchiver';
import { codemoggerStats } from './codemoggerServer';
import { collectSample } from './memoryReport';
import { memorySampler } from './memorySampler';

/**
 * Wire the memory sampler's probes and start it. Called from server.ts once the
 * HTTP server is listening.
 *
 * WHY AT BOOT rather than lazily from the diagnostics route: the route-triggered
 * start only samples from the first time someone opens the endpoint, so a
 * restart silently produces a coverage hole for however long nobody looks —
 * which is exactly when a slow leak is accumulating unobserved. A 10-hour gap
 * was lost that way before this existed.
 *
 * Must run AFTER migrateFuryHome(), since samples are written under
 * furyLogsDir() and the migration moves that directory.
 *
 * Idempotent: memorySampler.start() is a no-op once the timer exists, so an
 * HMR re-import or a stray call can't stack a second interval.
 */
export function startMemorySampling(): void {
  memorySampler.start(() => collectSample({
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
  }));
}
