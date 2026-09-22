import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { classifyChange, countTreeEntries, MAX_TREE_NODES, type ChangeKind } from '@/lib/fileTree';

// Metadata bursts are longer than a file save: a commit writes the index, then
// objects, then refs. Waiting a little longer avoids reading a half-done commit.
const FILE_DEBOUNCE_MS = 300;
const VCS_DEBOUNCE_MS = 500;

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const dirPath = searchParams.get('path');

  if (!dirPath) {
    return new Response('Directory path is required', { status: 400 });
  }

  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return new Response('Path is not a directory', { status: 400 });
    }
  } catch {
    return new Response('Directory does not exist', { status: 404 });
  }

  // Size sanity check before attaching a recursive watcher. On a directory this
  // large every write underneath triggers a full tree refetch, and the refetch
  // itself takes tens of seconds — together that's enough to take the server
  // down. Drive roots are the obvious case, but any large share or monorepo
  // hits it too. Bounded: gives up as soon as the cap is passed.
  const { exceeded } = await countTreeEntries(dirPath, MAX_TREE_NODES);
  if (exceeded) {
    console.warn(`/api/tree/watch: refusing to watch ${dirPath} (over ${MAX_TREE_NODES} entries)`);
    // A non-2xx status makes EventSource fail permanently rather than
    // reconnecting in a loop.
    return new Response('Directory too large to watch', { status: 413 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // One debounce timer per event kind, so a burst of file saves can't keep
      // postponing a pending vcs refresh (or the reverse).
      const debounceTimers = new Map<ChangeKind, ReturnType<typeof setTimeout>>();

      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      };

      // Send initial keepalive
      send(JSON.stringify({ type: 'connected' }));

      // Keep-alive ping every 30s to prevent timeout
      const keepAlive = setInterval(() => {
        send(JSON.stringify({ type: 'ping' }));
      }, 30000);

      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dirPath, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;

          // A commit/stage/branch-switch only ever touches .git or .svn, so
          // those events are the sole signal that status badges went stale.
          const kind = classifyChange(filename);
          if (!kind) return;

          // Debounce per kind: batch rapid changes into a single event. A
          // commit fires ~70 raw events, nearly all of them metadata.
          const pending = debounceTimers.get(kind);
          if (pending) clearTimeout(pending);
          debounceTimers.set(kind, setTimeout(() => {
            debounceTimers.delete(kind);
            send(JSON.stringify({
              type: kind === 'vcs' ? 'vcs-change' : 'change',
              path: path.join(dirPath, filename),
              filename,
            }));
          }, kind === 'vcs' ? VCS_DEBOUNCE_MS : FILE_DEBOUNCE_MS));
        });
      } catch (err) {
        console.error('Error starting fs.watch:', err);
        send(JSON.stringify({ type: 'error', message: 'Failed to start file watcher' }));
        controller.close();
        clearInterval(keepAlive);
        return;
      }

      // Clean up when the client disconnects
      request.signal.addEventListener('abort', () => {
        for (const t of debounceTimers.values()) clearTimeout(t);
        debounceTimers.clear();
        clearInterval(keepAlive);
        watcher.close();
        try {
          controller.close();
        } catch {
          // Already closed
        }
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
