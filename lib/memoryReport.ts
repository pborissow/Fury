/**
 * Retention sizing for the memory diagnostic (`GET /api/diagnostics/memory`).
 *
 * Deliberately does NOT use JSON.stringify: the whole point is to measure
 * buffers that may hold hundreds of MB, and serializing one to measure it would
 * allocate a string just as large — risking the very OOM being diagnosed. This
 * walks the structure and accumulates sizes instead, under a hard node budget
 * so a pathological object can't make the diagnostic itself expensive.
 */

/** Rough JS heap footprint, in bytes, of a value. */
export interface SizeResult {
  bytes: number;
  /** True if the walk hit its node budget and the size is a lower bound. */
  truncated: boolean;
}

// V8 stores strings as UTF-16; 2 bytes/char plus object header. Close enough
// for "is this 4KB or 40MB", which is the only question being asked.
const BYTES_PER_CHAR = 2;
const OBJECT_OVERHEAD = 48;
const DEFAULT_NODE_BUDGET = 50_000;

export function roughBytes(value: unknown, nodeBudget = DEFAULT_NODE_BUDGET): SizeResult {
  let bytes = 0;
  let nodes = 0;
  let truncated = false;
  // Guards cycles (a tool input can reference shared structures) and stops the
  // same object being counted twice within one walk.
  const seen = new WeakSet<object>();

  const walk = (v: unknown): void => {
    if (truncated) return;
    if (++nodes > nodeBudget) {
      truncated = true;
      return;
    }

    switch (typeof v) {
      case 'string':
        bytes += v.length * BYTES_PER_CHAR + 16;
        return;
      case 'number':
        bytes += 8;
        return;
      case 'boolean':
        bytes += 4;
        return;
      case 'bigint':
        bytes += 16;
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
        return;
      default:
        break;
    }

    if (v === null) return;
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);

    bytes += OBJECT_OVERHEAD;

    if (ArrayBuffer.isView(v)) {
      bytes += (v as ArrayBufferView).byteLength;
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (truncated) return;
        walk(item);
      }
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (truncated) return;
      bytes += k.length * BYTES_PER_CHAR;
      walk(val);
    }
  };

  walk(value);
  return { bytes, truncated };
}

/** Per-session retention, as reported by each session manager. */
export interface SessionMemoryRow {
  sessionId: string;
  /** Whether a query/process is still attached — i.e. the session is alive. */
  live: boolean;
  isProcessing: boolean;
  /** ms since this session last did anything. */
  idleMs: number;
  hasBuffer: boolean;
  /** Whether the buffer is still accepting events. */
  bufferActive: boolean;
  /** ms since the buffer closed, or null while still active. Compare against
   *  the manager's BUFFER_TTL: anything far past it is retained-but-expired. */
  bufferClosedForMs: number | null;
  bufferEvents: number;
  accumulatedTextChars: number;
  /** Rough retained bytes for the buffer (see roughBytes). */
  bufferBytes: number;
  bufferBytesTruncated: boolean;
}

export interface ManagerMemoryReport {
  manager: string;
  sessionCount: number;
  liveCount: number;
  /** Sessions retaining a buffer whose TTL has already elapsed — the ones the
   *  pull-only expiry never reclaimed because nothing polled them again. */
  expiredBufferCount: number;
  totalBufferEvents: number;
  totalBufferBytes: number;
  /** Heaviest sessions first. */
  top: SessionMemoryRow[];
  /** Set when the manager couldn't be read (shape changed, not yet started). */
  error?: string;
}

/** Minimal shape this reads off a session, common to both managers. */
interface AnySession {
  isProcessing?: boolean;
  lastActivity?: number;
  streamBuffer?: {
    events?: unknown[];
    accumulatedText?: string;
    isActive?: boolean;
    completedAt?: number;
  };
  /** SDK manager: the live query. CLI manager: the child process. */
  q?: unknown;
  currentProcess?: unknown;
}

/**
 * Build a retention report by reading a session manager's internal `sessions`
 * map directly.
 *
 * This reaches past `private` deliberately, for two reasons. First, the
 * managers are pinned to globalThis to survive HMR, so a method added to the
 * class is NOT present on an instance that is already running — and the whole
 * point of this diagnostic is to inspect a long-lived process mid-leak, without
 * the restart that would destroy the evidence. Second, it is strictly
 * read-only: it must not call getStreamBuffer(), whose TTL check has the side
 * effect of dropping the buffer it inspects, which would let polling mask the
 * growth being measured.
 */
export function buildManagerReport(
  manager: string,
  mgr: unknown,
  topN = 15,
): ManagerMemoryReport {
  const empty: ManagerMemoryReport = {
    manager, sessionCount: 0, liveCount: 0, expiredBufferCount: 0,
    totalBufferEvents: 0, totalBufferBytes: 0, top: [],
  };

  const sessions = (mgr as { sessions?: unknown })?.sessions;
  if (!(sessions instanceof Map)) {
    return { ...empty, error: 'sessions map not readable (manager shape changed?)' };
  }
  const ttl = Number((mgr as { BUFFER_TTL?: number })?.BUFFER_TTL) || 60_000;

  const now = Date.now();
  const rows: SessionMemoryRow[] = [];
  let expiredBufferCount = 0;
  let liveCount = 0;

  for (const [sessionId, raw] of sessions as Map<string, AnySession>) {
    const s = raw || {};
    const buf = s.streamBuffer;
    const live = !!(s.q ?? s.currentProcess);
    if (live) liveCount++;

    const closedFor = buf && !buf.isActive && buf.completedAt ? now - buf.completedAt : null;
    if (closedFor !== null && closedFor > ttl) expiredBufferCount++;

    const sized = buf ? roughBytes(buf) : { bytes: 0, truncated: false };
    rows.push({
      sessionId: String(sessionId),
      live,
      isProcessing: !!s.isProcessing,
      idleMs: now - (s.lastActivity || now),
      hasBuffer: !!buf,
      bufferActive: !!buf?.isActive,
      bufferClosedForMs: closedFor,
      bufferEvents: buf?.events?.length ?? 0,
      accumulatedTextChars: buf?.accumulatedText?.length ?? 0,
      bufferBytes: sized.bytes,
      bufferBytesTruncated: sized.truncated,
    });
  }

  rows.sort((a, b) => b.bufferBytes - a.bufferBytes);
  return {
    manager,
    sessionCount: sessions.size,
    liveCount,
    expiredBufferCount,
    totalBufferEvents: rows.reduce((n, r) => n + r.bufferEvents, 0),
    totalBufferBytes: rows.reduce((n, r) => n + r.bufferBytes, 0),
    top: rows.slice(0, topN),
  };
}

// ---------------------------------------------------------------------------
// Full snapshot
// ---------------------------------------------------------------------------

/**
 * One telemetry sample. Kept deliberately flat and small (a few hundred bytes
 * of JSON) so it can be appended every minute for days without the telemetry
 * itself becoming a retention problem.
 */
export interface MemorySample {
  t: number;
  /** Process id. Samples from successive runs land in the same daily file, and
   *  a restart is only otherwise detectable by inferring that uptimeSec went
   *  backwards. An explicit pid makes run segmentation exact — and makes a gap
   *  in coverage obvious rather than something you have to notice. */
  pid: number;
  uptimeSec: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  heapLimitMb: number;
  /** Per-space used MB. `large_object_space` growing while `old_space` is flat
   *  points at big-string/array churn and fragmentation (transcript re-parse)
   *  rather than an object-graph leak. */
  spacesMb: Record<string, number>;
  /** Retention counters, flattened to `group.metric`. */
  counters: Record<string, number>;
}

const toMb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

/** Best-effort read of a possibly-absent probe; never throws into the sample. */
function probe<T extends Record<string, number>>(fn: () => T, prefix: string, out: Record<string, number>) {
  try {
    for (const [k, v] of Object.entries(fn())) {
      if (typeof v === 'number') out[`${prefix}.${k}`] = v;
    }
  } catch {
    out[`${prefix}.unavailable`] = 1;
  }
}

/** Size of a Map/Set held on a singleton, read defensively. */
function sizeOf(holder: unknown, field: string): number {
  const v = (holder as Record<string, unknown> | undefined)?.[field];
  if (v instanceof Map || v instanceof Set) return v.size;
  return -1;
}

export interface SnapshotDeps {
  sdkSessionManager: unknown;
  sessionManager: unknown;
  fileWatchers?: unknown;
  mcpCache?: unknown;
  treeWatchers?: { watchedDirCount?: () => number };
  eventBus?: { listenerCount?: (e: string) => number };
  subagentUsageCacheStats?: () => Record<string, number>;
  sessionPathsCacheStats?: () => Record<string, number>;
  archiverLockStats?: () => Record<string, number>;
  codemoggerStats?: () => Record<string, number>;
}

export function collectSample(deps: SnapshotDeps): MemorySample {
  const mem = process.memoryUsage();
  const v8 = require('node:v8') as typeof import('v8');

  const spacesMb: Record<string, number> = {};
  try {
    for (const sp of v8.getHeapSpaceStatistics()) {
      spacesMb[sp.space_name] = toMb(sp.space_used_size);
    }
  } catch { /* older node */ }

  const counters: Record<string, number> = {};

  // Session managers — the map that only an explicit delete prunes.
  for (const [name, mgr] of [['sdk', deps.sdkSessionManager], ['cli', deps.sessionManager]] as const) {
    try {
      const r = buildManagerReport(name, mgr, 0);
      counters[`${name}.sessions`] = r.sessionCount;
      counters[`${name}.live`] = r.liveCount;
      counters[`${name}.expiredBuffers`] = r.expiredBufferCount;
      counters[`${name}.bufferEvents`] = r.totalBufferEvents;
      counters[`${name}.bufferMb`] = toMb(r.totalBufferBytes);
    } catch {
      counters[`${name}.unavailable`] = 1;
    }
  }

  // Ref-counted watchers: these only decrement from an SSE abort handler, so a
  // missed disconnect shows up here as a count that never comes back down.
  if (deps.fileWatchers) {
    counters['fileWatchers.transcript'] = sizeOf(deps.fileWatchers, 'transcriptWatchers');
    counters['fileWatchers.refCounts'] = sizeOf(deps.fileWatchers, 'transcriptRefCounts');
    counters['fileWatchers.pendingDir'] = sizeOf(deps.fileWatchers, 'pendingDirWatchers');
    counters['fileWatchers.sessionProjects'] = sizeOf(deps.fileWatchers, 'sessionProjects');
    counters['fileWatchers.debounces'] = sizeOf(deps.fileWatchers, 'transcriptDebounces');
  }
  if (deps.mcpCache) {
    counters['mcpCache.entries'] = sizeOf(deps.mcpCache, 'cache');
    counters['mcpCache.inflight'] = sizeOf(deps.mcpCache, 'inflight');
  }
  try {
    if (deps.treeWatchers?.watchedDirCount) counters['treeWatchers.dirs'] = deps.treeWatchers.watchedDirCount();
  } catch { /* ignore */ }
  try {
    // A listener count that climbs is the classic per-connection leak.
    if (deps.eventBus?.listenerCount) counters['eventBus.appListeners'] = deps.eventBus.listenerCount('app-event');
  } catch { /* ignore */ }

  if (deps.subagentUsageCacheStats) probe(deps.subagentUsageCacheStats, 'subagentUsage', counters);
  if (deps.sessionPathsCacheStats) probe(deps.sessionPathsCacheStats, 'sessionPaths', counters);
  if (deps.archiverLockStats) probe(deps.archiverLockStats, 'archiver', counters);
  if (deps.codemoggerStats) probe(deps.codemoggerStats, 'codemogger', counters);

  let heapLimitMb = 0;
  try { heapLimitMb = toMb(v8.getHeapStatistics().heap_size_limit); } catch { /* ignore */ }

  return {
    t: Date.now(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
    heapLimitMb,
    spacesMb,
    counters,
  };
}
