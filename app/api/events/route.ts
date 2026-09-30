import { NextRequest } from 'next/server';
import { eventBus, AppEvent } from '@/lib/eventBus';
import { liveSessionScanner } from '@/lib/liveSessionScanner';
import { fileWatchers } from '@/lib/fileWatchers';
import { startArchiveListener } from '@/lib/transcriptArchiver';
import { mcpCache } from '@/lib/mcpCache';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { computeLiveSessionIds } from '@/lib/liveSessions';
import { eventSubscriptions, isValidSessionWatch } from '@/lib/eventSubscriptions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_MS = 30_000;
/** Cap on chunks queued for a client that has stopped reading. */
const MAX_QUEUED_CHUNKS = 256;
/** Consecutive undrained keep-alives before we declare the peer gone.
 *  At KEEPALIVE_MS this is ~2 minutes of a reader that never pulls. */
const MAX_STALLED_PINGS = 4;

/**
 * GET /api/events — the app-wide SSE stream. Each window holds ONE of these
 * (lib/appEventStream.ts).
 *
 * Session-scoped events (session-stream/-health/-model/-usage/-limit,
 * transcript-updated) are delivered only for sessions this stream WATCHES. The
 * `connected` event carries a `subscriptionId`, and the client adds or removes
 * watched sessions via `POST /api/events` (below). Keeping them on this stream,
 * rather than a second per-session stream, is what keeps a window within the
 * browser's ~6-connections-per-origin budget.
 *
 * Legacy: `?sessionId=…&project=…` seeds the watch set for that one session.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const legacySessionId = searchParams.get('sessionId');
  const legacyProject = searchParams.get('project');

  // Ensure global services are running (idempotent)
  liveSessionScanner.start();
  fileWatchers.startHistoryWatcher();
  startArchiveListener();
  mcpCache.start();

  const subscriptionId = eventSubscriptions.create();
  const legacyWatch = { sessionId: legacySessionId, project: legacyProject };
  if (isValidSessionWatch(legacyWatch)) {
    eventSubscriptions.watch(subscriptionId, legacyWatch.sessionId, legacyWatch.project);
  }
  const watching = (sessionId: string) => eventSubscriptions.isWatching(subscriptionId, sessionId);

  const encoder = new TextEncoder();
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      let torn = false;
      /** Detaches the eventBus subscription; set once it exists, so `release`
       *  never depends on `handler` being defined yet. */
      let detach: () => void = () => {};

      /**
       * Idempotent teardown — reachable from `abort`, the stream's `cancel()`,
       * and the liveness probe below.
       *
       * Defensive hardening. This route used to clean up ONLY on
       * `request.signal`'s abort, so a consumer that vanished without one — a
       * half-open socket (laptop sleep, Wi-Fi drop, NAT eviction) never emits a
       * FIN — would keep its eventBus listener, keep-alive timer and transcript
       * watch forever. Not observed causing the 2026-09-30 transcript hang (that
       * was live streams across two windows filling the browser's per-origin
       * connection pool; see lib/appEventStream.ts), but the same gap
       * /api/tree/watch's release() already closes.
       */
      const release = () => {
        if (torn) return;
        torn = true;
        if (keepAlive) clearInterval(keepAlive);
        detach();
        // Releases EVERY session this stream watched (their transcript watchers).
        eventSubscriptions.close(subscriptionId);
        try { controller.close(); } catch { /* already closed */ }
      };
      teardown = release;

      const send = (eventType: string, data: any) => {
        if (torn) return;
        try {
          // enqueue() does NOT throw when nobody is reading — it silently grows
          // an internal queue. Without this cap a client that stops draining is
          // an unbounded sink that also pins this route's eventBus listener.
          if (controller.desiredSize !== null && controller.desiredSize < -MAX_QUEUED_CHUNKS) {
            console.warn('/api/events: client stopped draining; closing');
            release();
            return;
          }
          controller.enqueue(
            encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          release();
        }
      };

      // Send initial connection confirmation
      // The subscriptionId drives the POST control channel. A reconnect gets a
      // NEW id, so the client must re-register its watched sessions.
      send('connected', { ts: Date.now(), subscriptionId });

      // Track the latest PID-scanner output and the last merged list we
      // sent. We re-merge whenever either source changes, and only push if
      // the resulting list differs from what we last sent (session:health
      // fires every few seconds while processing — skip the noise).
      let lastScannerIds: string[] = [];
      let lastSentKey = '';
      // Read a manager id list defensively — an HMR race can leave a manager
      // singleton momentarily unavailable; fall back to empty rather than throw.
      const safeIds = (fn: () => string[]): string[] => {
        try { return fn(); } catch { return []; }
      };
      const emitLiveSessionsIfChanged = () => {
        // "Live" = actively processing, not "has a warm process". For persistent
        // SDK sessions the PID scanner reports the warm process even at rest, so
        // computeLiveSessionIds subtracts Fury-managed SDK sessions and adds back
        // only the ones actually processing (isProcessing).
        const ids = computeLiveSessionIds({
          scannerIds: lastScannerIds,
          shippingActiveIds: safeIds(() => sessionManager.getActiveSessionIds()),
          sdkManagedIds: safeIds(() => sdkSessionManager.getManagedSessionIds()),
          sdkActiveIds: safeIds(() => sdkSessionManager.getActiveSessionIds()),
          backgroundActiveIds: safeIds(() => sdkSessionManager.getBackgroundActiveSessionIds()),
          furyWarmIds: safeIds(() => sdkSessionManager.getFuryWarmSessionIds()),
        });
        const key = ids.join(',');
        if (key === lastSentKey) return;
        lastSentKey = key;
        send('live-sessions', { liveSessionIds: ids });
      };

      // Subscribe to all events and forward relevant ones
      const handler = (payload: AppEvent) => {
        switch (payload.type) {
          case 'live-sessions':
            // Merge PID-scanner output with SessionManager-managed sessions
            // before forwarding. Without this, Fury-spawned `--resume` runs
            // on CLI v2.1.144+ never show a Live badge (their PID file
            // carries a per-spawn sessionId, not the conversation id).
            lastScannerIds = payload.liveSessionIds;
            emitLiveSessionsIfChanged();
            break;

          case 'history-updated':
            send('history-updated', {});
            break;

          case 'session:stream':
            if (watching(payload.sessionId)) {
              send('session-stream', payload);
            }
            break;

          case 'session:health':
            if (watching(payload.sessionId)) {
              send('session-health', payload);
            }
            // A Fury-managed session flipping isProcessing changes the live
            // list even when the PID scanner output is stable. Re-emit so
            // the badge appears/disappears in real time.
            emitLiveSessionsIfChanged();
            break;

          case 'session:model':
            if (watching(payload.sessionId)) {
              send('session-model', payload);
            }
            break;

          case 'session:usage':
            if (watching(payload.sessionId)) {
              send('session-usage', payload);
            }
            break;

          case 'transcript:updated':
            if (watching(payload.sessionId)) {
              send('transcript-updated', payload);
            }
            break;

          case 'provider:switched':
            send('provider-switched', payload);
            break;

          case 'session:limit':
            // Terminal usage/rate limit — only the tab watching this session
            // should raise the recovery dialog.
            if (watching(payload.sessionId)) {
              send('session-limit', payload);
            }
            break;

          case 'mcp:updated':
            send('mcp-updated', payload);
            break;
        }
      };

      eventBus.onApp(handler);
      detach = () => eventBus.offApp(handler);

      // Keep-alive ping every 30s to prevent HTTP timeout — and double as a
      // liveness probe. A half-open socket never aborts the request, so if our
      // own pings stop being drained the peer is gone regardless of what the
      // socket claims, and this stream (plus its eventBus listener and its slot
      // in the browser's connection pool) must not outlive it.
      let stalledPings = 0;
      keepAlive = setInterval(() => {
        if (controller.desiredSize !== null && controller.desiredSize < 0) {
          if (++stalledPings >= MAX_STALLED_PINGS) {
            console.warn(`/api/events: no reader across ${MAX_STALLED_PINGS} pings; closing`);
            release();
            return;
          }
        } else {
          stalledPings = 0;
        }
        send('ping', { ts: Date.now() });
      }, KEEPALIVE_MS);

      // Clean up on disconnect (and if the client was gone before we got here).
      if (request.signal.aborted) release();
      else request.signal.addEventListener('abort', release);
    },
    // The consumer went away without aborting the request.
    cancel() {
      teardown?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * POST /api/events — the control channel for a stream's watched sessions.
 *
 * Body: `{ subscriptionId, add?: [{ sessionId, project }], remove?: [sessionId] }`
 *
 * 404 means the subscription is gone (its stream closed or the server
 * restarted); the client reconnects and re-registers under a new id.
 * 422 means some adds were refused (invalid, or over the per-stream cap) and
 * lists them in `rejected`; everything else in the request was applied.
 */
export async function POST(request: NextRequest) {
  let body: { subscriptionId?: unknown; add?: unknown; remove?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { subscriptionId, add, remove } = body || {};
  if (typeof subscriptionId !== 'string' || !subscriptionId) {
    return new Response('subscriptionId is required', { status: 400 });
  }
  if (!eventSubscriptions.has(subscriptionId)) {
    return new Response('Unknown subscriptionId', { status: 404 });
  }

  if (Array.isArray(remove)) {
    for (const sessionId of remove) {
      if (typeof sessionId === 'string') eventSubscriptions.unwatch(subscriptionId, sessionId);
    }
  }
  // A refused add must not look like success: the client would mark it
  // confirmed and wait forever for events that will never come.
  const rejected: { sessionId: unknown; reason: 'invalid' | 'limit' }[] = [];
  if (Array.isArray(add)) {
    for (const w of add) {
      if (!isValidSessionWatch(w)) {
        rejected.push({ sessionId: (w as { sessionId?: unknown } | null)?.sessionId ?? null, reason: 'invalid' });
        continue;
      }
      if (eventSubscriptions.watch(subscriptionId, w.sessionId, w.project) === 'full') {
        rejected.push({ sessionId: w.sessionId, reason: 'limit' });
      }
    }
  }

  // 422: the request was processed, but some adds were refused. Every other
  // add and remove in it WAS applied; `rejected` names the ones that weren't.
  return new Response(JSON.stringify(rejected.length ? { success: false, rejected } : { success: true }), {
    status: rejected.length ? 422 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
