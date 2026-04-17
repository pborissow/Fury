import { NextRequest } from 'next/server';
import { eventBus, AppEvent } from '@/lib/eventBus';
import { liveSessionScanner } from '@/lib/liveSessionScanner';
import { fileWatchers } from '@/lib/fileWatchers';
import { startArchiveListener } from '@/lib/transcriptArchiver';
import { mcpCache } from '@/lib/mcpCache';

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

      // Subscribe to all events and forward relevant ones
      const handler = (payload: AppEvent) => {
        switch (payload.type) {
          case 'live-sessions':
            send('live-sessions', { liveSessionIds: payload.liveSessionIds });
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
