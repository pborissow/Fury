/**
 * Browser -> server telemetry. The UI's decision points (health-poll teardown,
 * the strip branch taken on restore, an SSE error, a stream error surfaced to the
 * user) call `uiLog(...)`; entries are batched and POSTed to /api/telemetry, which
 * folds them into the same log stream as the server (see lib/logger.ts).
 *
 * The whole point is correlation. Every event from this tab carries the same
 * `corrId` (a per-tab id), so the server log can group "what this browser did"
 * and interleave it with "what the server did for that session" by timestamp.
 *
 * Design constraints:
 *  - Never throw into a caller. A telemetry call inside a React effect must be as
 *    safe as a console.log.
 *  - Survive unload. The most interesting events (dots vanished, error shown)
 *    often precede a navigation/close, so we flush on pagehide via sendBeacon.
 *  - Cheap. Batches on a short debounce; coalesces bursts into one request.
 */

export type UiLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface UiEntry {
  ts: number;
  level: UiLogLevel;
  scope: string;
  msg: string;
  sessionId?: string;
  corrId: string;
  data?: Record<string, unknown>;
}

// Per-tab correlation id, minted once per page load. Stable across every uiLog
// call from this tab so the server can group them.
const corrId: string = (() => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
})();

const ENDPOINT = '/api/telemetry';
const FLUSH_DEBOUNCE_MS = 1500;
const MAX_BATCH = 25;

const queue: UiEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unloadHooked = false;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** POST the current queue. Uses sendBeacon when leaving the page (fetch may be
 *  cancelled during unload), plain keepalive fetch otherwise. Never throws. */
function flush(useBeacon = false): void {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  const payload = JSON.stringify({ events: batch });

  try {
    if (useBeacon && typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      const ok = navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'text/plain' }));
      if (ok) return;
      // Beacon refused (payload too large / queue full) — fall through to fetch.
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // Telemetry is best-effort; a dropped batch must not surface anywhere.
    });
  } catch {
    // Swallow: never let telemetry break the caller.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush(false);
  }, FLUSH_DEBOUNCE_MS);
}

function hookUnloadOnce(): void {
  if (unloadHooked || !isBrowser()) return;
  unloadHooked = true;
  // pagehide fires on tab close AND on bfcache navigation; visibilitychange to
  // hidden covers the "switched away and never came back" case.
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

/**
 * Record a UI event. Fire-and-forget. Example:
 *   uiLog('warn', 'chat.healthPoll', 'teardown after 2 false', { sessionId, data: { streak } });
 */
export function uiLog(
  level: UiLogLevel,
  scope: string,
  msg: string,
  opts?: { sessionId?: string; data?: Record<string, unknown> },
): void {
  if (!isBrowser()) return;
  hookUnloadOnce();

  queue.push({
    ts: Date.now(),
    level,
    scope,
    msg,
    sessionId: opts?.sessionId,
    corrId,
    data: opts?.data,
  });

  if (queue.length >= MAX_BATCH) flush(false);
  else scheduleFlush();
}

/** The current tab's correlation id — handy to render in a debug corner if ever
 *  needed so a user can quote it when reporting a problem. */
export function telemetryCorrId(): string {
  return corrId;
}
