import { NextRequest } from 'next/server';
import { eventBus, AppEvent } from '@/lib/eventBus';
import { liveSessionScanner } from '@/lib/liveSessionScanner';
import { fileWatchers } from '@/lib/fileWatchers';
import { startArchiveListener } from '@/lib/transcriptArchiver';
import { mcpCache } from '@/lib/mcpCache';
import { sessionManager } from '@/lib/sessionManager';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const watchSessionId = searchParams.get('sessionId');
  const watchProject = searchParams.get('project');

  // Ensure global services are running (idempotent)
  liveSessionScanner.start();
  fileWatchers.startHistoryWatcher();
  startArchiveListener();
  mcpCache.start();

  // If the client wants transcript updates for a specific session, start watching
  if (watchSessionId && watchProject) {
    fileWatchers.watchTranscript(watchSessionId, watchProject);
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (eventType: string, data: any) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      // Send initial connection confirmation
      send('connected', { ts: Date.now() });

      // Keep-alive ping every 30s to prevent HTTP timeout
      const keepAlive = setInterval(() => {
        send('ping', { ts: Date.now() });
      }, 30_000);

      // Track the latest PID-scanner output and the last merged list we
      // sent. We re-merge whenever either source changes, and only push if
      // the resulting list differs from what we last sent (session:health
      // fires every few seconds while processing — skip the noise).
      let lastScannerIds: string[] = [];
      let lastSentKey = '';
      const emitLiveSessionsIfChanged = () => {
        const merged = new Set<string>(lastScannerIds);
        try {
          for (const id of sessionManager.getActiveSessionIds()) merged.add(id);
        } catch { /* manager unavailable (e.g. HMR race) — fall back to scanner-only */ }
        const ids = [...merged].sort();
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
            if (watchSessionId && payload.sessionId === watchSessionId) {
              send('session-stream', payload);
            }
            break;

          case 'session:health':
            if (watchSessionId && payload.sessionId === watchSessionId) {
              send('session-health', payload);
            }
            // A Fury-managed session flipping isProcessing changes the live
            // list even when the PID scanner output is stable. Re-emit so
            // the badge appears/disappears in real time.
            emitLiveSessionsIfChanged();
            break;

          case 'session:model':
            if (watchSessionId && payload.sessionId === watchSessionId) {
              send('session-model', payload);
            }
            break;

          case 'transcript:updated':
            if (watchSessionId && payload.sessionId === watchSessionId) {
              send('transcript-updated', payload);
            }
            break;

          case 'provider:switched':
            send('provider-switched', payload);
            break;

          case 'mcp:updated':
            send('mcp-updated', payload);
            break;
        }
      };

      eventBus.onApp(handler);

      // Clean up on disconnect
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(keepAlive);
        eventBus.offApp(handler);
        if (watchSessionId) {
          fileWatchers.unwatchTranscript(watchSessionId);
        }
        try { controller.close(); } catch { /* already closed */ }
      });
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
