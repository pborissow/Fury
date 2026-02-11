import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const IGNORED_ITEMS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.svn',
  'dist',
  'build',
  'out',
  '.DS_Store',
  'coverage',
  '.turbo',
  '.cache',
]);

function isIgnored(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  return parts.some((part) => IGNORED_ITEMS.has(part));
}

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

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
          if (filename && isIgnored(filename)) return;

          // Debounce: batch rapid changes into a single event
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const changedPath = filename ? path.join(dirPath, filename) : null;
            send(JSON.stringify({
              type: 'change',
              path: changedPath,
              filename: filename || null,
            }));
          }, 300);
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
        if (debounceTimer) clearTimeout(debounceTimer);
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
