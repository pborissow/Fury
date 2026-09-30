'use client';

/**
 * ONE shared EventSource for the global `/api/events` stream.
 *
 * WHY THIS EXISTS: a browser allows only ~6 concurrent HTTP/1.1 connections per
 * origin — and that budget is shared across EVERY tab, window and installed PWA
 * on the origin, not per page. An SSE stream holds one connection for its whole
 * life. Each Fury window held four permanent streams (a bare `/api/events` for
 * the session list, another for the MCP panel, the session-scoped
 * `/api/events?sessionId=…`, and `/api/tree/watch`), so a second window was
 * enough to exhaust the pool. Every ordinary fetch then queues behind the
 * streams indefinitely — including `/api/transcript` and the
 * `/api/stream-buffer` + `/api/health` restore chain after it — so the UI hangs
 * on "loading transcript" while the server is idle.
 *
 * All of them now share this one socket. That includes session-scoped events:
 * a consumer passes `watchSession`, and the multiplexer registers it with the
 * server over the `POST /api/events` control channel, keyed by the
 * `subscriptionId` the `connected` event carries. A window therefore holds two
 * streams (this one and `/api/tree/watch`), three with Source Control open, so
 * a browser tab plus the PWA stay under the limit.
 *
 * A reconnect is a NEW server-side stream with a NEW subscriptionId and no
 * watches, so every watched session is re-registered on each `connected`, and
 * `onWatching` fires again: that is the consumer's catch-up point.
 */

import { uiLog } from './clientTelemetry';

type Listener = (payload: any) => void;

export interface SessionWatch {
  sessionId: string;
  project: string;
}

export interface AppEventSubscription {
  /** SSE event name → handler, e.g. `{ 'live-sessions': fn }`. */
  on?: Record<string, Listener>;
  /**
   * The shared stream came back after a drop. Fired from `onopen` — i.e. once
   * the server is reachable again — never at the moment of the drop, when a
   * catch-up fetch would just fail against a server that is still down.
   */
  onReconnect?: () => void;
  /**
   * Also deliver this session's scoped events (`session-stream`,
   * `session-health`, `transcript-updated`, …). Watches are reference-counted
   * across subscribers. Handlers must still check `payload.sessionId`: the
   * socket carries every session this window watches.
   */
  watchSession?: SessionWatch;
  /**
   * The server confirmed `watchSession`, so its events now flow. Fires once the
   * watch is first registered and again after EVERY reconnect. Events emitted
   * before this point were not delivered, so this is where to re-sync.
   * `resumed` is false the first time (the consumer just fetched its own
   * baseline) and true after a reconnect (anything may have been missed).
   */
  onWatching?: (resumed: boolean) => void;
}

/** Backoff for reopening after a FATAL failure (the browser won't retry those). */
const REOPEN_MIN_MS = 1_000;
const REOPEN_MAX_MS = 30_000;

const subs = new Set<AppEventSubscription>();
let es: EventSource | null = null;
/** SSE event names currently bridged from the live socket into `subs`. */
const bridged = new Map<string, (e: Event) => void>();
/** Set on any error; the next successful open delivers `onReconnect`. */
let needsResync = false;
let reopenDelay = REOPEN_MIN_MS;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;

// --- Session watches (the POST /api/events control channel) ---

/** The live server-side stream's id; null until its `connected` event. */
let subscriptionId: string | null = null;

interface WatchEntry {
  project: string;
  subs: Set<AppEventSubscription>;
  /** The subscriptionId the server last confirmed this watch for. */
  confirmedFor: string | null;
}
/** Watched sessionId → its subscribers. */
const watches = new Map<string, WatchEntry>();
/** Subscribers whose `onWatching` has fired at least once (→ `resumed`). */
const watchedOnce = new WeakSet<AppEventSubscription>();

/** Attempts for a control POST that fails for a reason other than 404. */
const CONTROL_MAX_ATTEMPTS = 4;
const CONTROL_RETRY_MS = 500;
/**
 * Control POSTs run one at a time. Separate fetches may travel on different
 * connections, so a quick remove→add of one session could otherwise reach the
 * server as add→remove and leave it unwatched while the client thinks it's
 * confirmed.
 */
let controlChain: Promise<void> = Promise.resolve();
/** Consecutive watch registrations abandoned; drives recoverWatches' backoff.
 *  Reset by any control POST the server accepts. */
let controlFailures = 0;

function fireWatching(sub: AppEventSubscription) {
  const resumed = watchedOnce.has(sub);
  watchedOnce.add(sub);
  try {
    sub.onWatching?.(resumed);
  } catch (err) {
    console.error('appEventStream: onWatching handler threw', err);
  }
}

/** The server acknowledged `sessionIds` for stream `id`. */
function confirmWatches(id: string, sessionIds: string[]) {
  if (id !== subscriptionId) return; // a stream that has since been replaced
  for (const sessionId of sessionIds) {
    const entry = watches.get(sessionId);
    if (!entry || entry.confirmedFor === id) continue;
    entry.confirmedFor = id;
    for (const sub of [...entry.subs]) fireWatching(sub);
  }
}

async function postControl(id: string, add: SessionWatch[], remove: string[]) {
  let status = 0; // 0 = network error
  for (let attempt = 1; ; attempt++) {
    if (id !== subscriptionId) return; // stale: the next `connected` re-registers
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: id, add, remove }),
      });
      status = res.status;
      if (res.ok) {
        controlFailures = 0;
        confirmWatches(id, add.map(w => w.sessionId));
        return;
      }
      if (status === 422) {
        // Applied, except the adds the server refused (invalid id, or over the
        // per-stream cap). Confirm the rest; retrying or reconnecting won't
        // change a refusal, so just make it visible.
        let rejected: { sessionId?: unknown; reason?: unknown }[] = [];
        try {
          const body = await res.json();
          if (Array.isArray(body?.rejected)) rejected = body.rejected;
        } catch { /* treat as nothing listed */ }
        const refused = new Set(rejected.map(r => r?.sessionId));
        controlFailures = 0;
        confirmWatches(id, add.map(w => w.sessionId).filter(s => !refused.has(s)));
        uiLog('warn', 'sse.control', 'server refused session watch', { data: { rejected } });
        return;
      }
      // 404: the server doesn't know this id. 400: malformed. Retrying the
      // same request can't help either one.
      if (status === 404 || status === 400) break;
    } catch {
      status = 0; // network error — retry below
    }
    if (attempt >= CONTROL_MAX_ATTEMPTS) break;
    await new Promise(r => setTimeout(r, CONTROL_RETRY_MS * 2 ** (attempt - 1)));
  }

  // Gave up. If the socket has already moved on, its `connected` re-registers
  // everything and there is nothing to do.
  if (id !== subscriptionId) return;
  if (add.length > 0) {
    recoverWatches(id, add, status);
  } else if (status !== 404) {
    // An unwatch that didn't land costs only stray events (consumers filter by
    // sessionId) and a transcript watcher, both released when the stream closes.
    uiLog('warn', 'sse.control', 'session unwatch not delivered', { data: { remove, status } });
  }
}

/**
 * A watch could not be registered on a stream that still looks alive, so the
 * session would get no events until something else reconnected. Reopen the
 * stream: its `connected` re-registers every watch, and consumers get
 * `onWatching(true)` to catch up. Backs off on its own counter, since a
 * successful `onopen` resets the socket's reopen delay and would otherwise let
 * a persistently failing POST reconnect every second.
 */
function recoverWatches(id: string, add: SessionWatch[], status: number) {
  if (id !== subscriptionId || !es) return;
  controlFailures++;
  const delay = Math.min(REOPEN_MIN_MS * 2 ** (controlFailures - 1), REOPEN_MAX_MS);
  uiLog('warn', 'sse.control', 'session watch not registered; reconnecting', {
    data: { sessions: add.map(w => w.sessionId), status, failures: controlFailures, delayMs: delay },
  });
  dropSocket();
  needsResync = true;
  if (reopenTimer) return;
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    if (subs.size > 0) openStream();
  }, delay);
}

function sendControl(add: SessionWatch[], remove: string[]) {
  const id = subscriptionId;
  if (!id || (add.length === 0 && remove.length === 0)) return;
  controlChain = controlChain.then(() => postControl(id, add, remove)).catch(() => {});
}

/** A new server-side stream: register every watched session against it. */
function onConnected(e: Event) {
  let id: unknown;
  try {
    id = JSON.parse((e as MessageEvent).data)?.subscriptionId;
  } catch {
    return;
  }
  subscriptionId = typeof id === 'string' && id ? id : null;
  sendControl([...watches].map(([sessionId, w]) => ({ sessionId, project: w.project })), []);
}

// --- Socket lifecycle ---

/** Forward one SSE event name to every subscriber that wants it. */
function bridge(type: string) {
  const src = es;
  if (!src || bridged.has(type)) return;
  const fn = (e: Event) => {
    let payload: unknown;
    try {
      payload = JSON.parse((e as MessageEvent).data);
    } catch {
      return; // malformed frame — ignore, as the per-consumer handlers did
    }
    // Iterate a snapshot: a handler may subscribe or unsubscribe during dispatch.
    for (const s of [...subs]) s.on?.[type]?.(payload);
  };
  src.addEventListener(type, fn);
  bridged.set(type, fn);
}

/** Drop the socket and its bridges (they belong to that EventSource instance). */
function dropSocket() {
  es?.close();
  es = null;
  bridged.clear();
  subscriptionId = null;
}

function scheduleReopen() {
  if (reopenTimer || subs.size === 0) return;
  const delay = reopenDelay;
  reopenDelay = Math.min(reopenDelay * 2, REOPEN_MAX_MS);
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    if (subs.size > 0) openStream();
  }, delay);
}

function openStream() {
  if (es) return;
  const src = new EventSource('/api/events');
  es = src;
  src.addEventListener('connected', (e) => {
    if (es === src) onConnected(e);
  });
  src.onopen = () => {
    reopenDelay = REOPEN_MIN_MS;
    if (!needsResync) return; // first open: consumers fetched their own baseline
    needsResync = false;
    for (const s of [...subs]) s.onReconnect?.();
  };
  src.onerror = () => {
    if (es !== src) return; // a socket we already replaced
    needsResync = true;
    // The server-side stream behind this id is gone either way; the next
    // `connected` brings a new one, and the watches are re-registered then.
    subscriptionId = null;
    // CONNECTING: the browser is retrying on its own; `onopen` finishes the job.
    // CLOSED: a fatal failure (e.g. a non-200 while the dev server restarts) —
    // the browser will NOT retry, so without this the stream stayed dead and
    // every consumer went silent until a page reload.
    if (src.readyState === EventSource.CLOSED) {
      dropSocket();
      scheduleReopen();
    }
  };
  for (const s of subs) for (const type of Object.keys(s.on ?? {})) bridge(type);
}

function closeStream() {
  if (reopenTimer) {
    clearTimeout(reopenTimer);
    reopenTimer = null;
  }
  dropSocket();
  needsResync = false;
  reopenDelay = REOPEN_MIN_MS;
  controlFailures = 0;
}

/**
 * Join the shared `/api/events` stream. Returns an unsubscribe suitable as a
 * `useEffect` cleanup; the socket closes once the last consumer leaves.
 */
export function subscribeAppEvents(sub: AppEventSubscription): () => void {
  subs.add(sub);
  // While a reopen is pending, joining must not jump the backoff.
  if (!reopenTimer) openStream();
  for (const type of Object.keys(sub.on ?? {})) bridge(type);

  const watch = sub.watchSession ? { ...sub.watchSession } : null;
  if (watch) {
    const existing = watches.get(watch.sessionId);
    if (!existing) {
      watches.set(watch.sessionId, { project: watch.project, subs: new Set([sub]), confirmedFor: null });
      sendControl([watch], []);
    } else {
      existing.subs.add(sub);
      // Already live on the server: confirm to this subscriber now. Async, like
      // a real confirmation, so it never runs inside the caller's effect body.
      const id = subscriptionId;
      if (id && existing.confirmedFor === id) {
        queueMicrotask(() => {
          if (existing.subs.has(sub) && id === subscriptionId && existing.confirmedFor === id) {
            fireWatching(sub);
          }
        });
      }
    }
  }

  let done = false;
  return () => {
    if (done) return; // idempotent — a cleanup may run more than once
    done = true;
    subs.delete(sub);
    if (watch) {
      const entry = watches.get(watch.sessionId);
      if (entry?.subs.delete(sub) && entry.subs.size === 0) {
        watches.delete(watch.sessionId);
        // Closing the socket releases every watch server-side; no POST needed then.
        if (subs.size > 0) sendControl([], [watch.sessionId]);
      }
    }
    if (subs.size === 0) closeStream();
  };
}

/** Test/diagnostics hook: how many consumers share the socket right now. */
export function appEventSubscriberCount(): number {
  return subs.size;
}

/** Test/diagnostics hook: the sessions this window currently watches. */
export function appEventWatchedSessions(): string[] {
  return [...watches.keys()];
}
