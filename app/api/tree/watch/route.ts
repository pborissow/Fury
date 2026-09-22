import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { treeWatchers, type WatchOptions } from '@/lib/treeWatchers';
import { type ChangeKind } from '@/lib/fileTree';

// Metadata bursts are longer than a file save: a commit writes the index, then
// objects, then refs. Waiting a little longer avoids reading a half-done commit.
const FILE_DEBOUNCE_MS = 300;
const VCS_DEBOUNCE_MS = 500;

const KEEPALIVE_MS = 30_000;
/** Queued-but-undrained chunks tolerated before the peer is presumed gone. */
const MAX_QUEUED_CHUNKS = 256;
/** Consecutive keepalives that go undrained before the peer is presumed gone.
 *  At KEEPALIVE_MS this is ~2 minutes of a reader that never pulls. */
const MAX_STALLED_PINGS = 4;

export const dynamic = 'force-dynamic';

/**
 * A live SSE subscription. The tree is lazy-loaded, so the set of directories a
 * client cares about changes over time (folders open and close). SSE is
 * server→client only, so the client adjusts that set via `POST /api/tree/watch`
 * (the control channel), keyed by the `subscriptionId` returned on connect.
 *
 * Every watched dir goes through the shared, ref-counted `treeWatchers` registry
 * so two sessions viewing the same folder share ONE OS-level watcher.
 */
interface Subscription {
  root: string;
  send: (data: string) => void;
  /** watched dir → its registry unsubscribe handle */
  dirs: Map<string, () => void>;
  /** debounce timers, keyed by `${dir}\0${kind}` so each dir/kind coalesces
   *  independently (a burst in one folder can't swallow another's event). */
  timers: Map<string, ReturnType<typeof setTimeout>>;
  closed: boolean;
}

/**
 * Locate the VCS metadata directory to watch, plus the prefix its events should
 * be classified under ('.git'/'.svn'). Handles the linked-worktree / submodule
 * case where `<root>/.git` is a FILE containing "gitdir: <path>" pointing at the
 * real metadata dir — without this, those repos would attach no VCS-meta watch
 * and badges wouldn't live-refresh on commit/stage there.
 */
function detectVcsMetaDir(root: string): { dir: string; prefix: string } | null {
  // .git — usually a directory, sometimes a gitdir-pointer file.
  const dotGit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return { dir: dotGit, prefix: '.git' };
    if (st.isFile()) {
      const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (m) {
        const resolved = path.resolve(root, m[1]);
        if (fs.statSync(resolved).isDirectory()) return { dir: resolved, prefix: '.git' };
      }
    }
  } catch {
    // not git / unreadable
  }

  // .svn is always a directory.
  const dotSvn = path.join(root, '.svn');
  try {
    if (fs.statSync(dotSvn).isDirectory()) return { dir: dotSvn, prefix: '.svn' };
  } catch {
    // not svn
  }

  return null;
}

/** Reject anything that isn't a real directory strictly inside `root` — the
 *  control channel must not become an arbitrary-path watch primitive. */
function isInsideRoot(root: string, dir: string): boolean {
  const r = path.resolve(root);
  const d = path.resolve(dir);
  return d === r || d.startsWith(r + path.sep);
}

class TreeWatchRegistry {
  private subs = new Map<string, Subscription>();

  create(root: string, send: (data: string) => void): string {
    const id = randomUUID();
    const sub: Subscription = { root, send, dirs: new Map(), timers: new Map(), closed: false };
    this.subs.set(id, sub);

    // The root is always watched (non-recursive) so new/removed TOP-LEVEL
    // entries appear even with nothing expanded.
    this.subscribeDir(sub, root, { recursive: false });

    // A non-recursive watch of open folders can't see nested .git/.svn writes
    // (index, refs, HEAD) — the sole signal for commit/stage/branch-switch — so
    // watch the VCS metadata dir directly, recursively (it's small). This is
    // what refreshes ALL badges (incl. collapsed-folder dots) on a VCS event.
    const meta = detectVcsMetaDir(root);
    if (meta) this.subscribeDir(sub, meta.dir, { recursive: true, classifyPrefix: meta.prefix });

    return id;
  }

  private subscribeDir(sub: Subscription, dir: string, opts: WatchOptions) {
    if (sub.dirs.has(dir)) return;
    const unsub = treeWatchers.watch(dir, opts, (kind, filename) => {
      this.onChange(sub, dir, kind, filename);
    });
    sub.dirs.set(dir, unsub);
  }

  private unsubscribeDir(sub: Subscription, dir: string) {
    const unsub = sub.dirs.get(dir);
    if (!unsub) return;
    unsub();
    sub.dirs.delete(dir);
    for (const key of [...sub.timers.keys()]) {
      if (key.startsWith(dir + '\0')) {
        clearTimeout(sub.timers.get(key)!);
        sub.timers.delete(key);
      }
    }
  }

  addDirs(id: string, dirs: string[]): boolean {
    const sub = this.subs.get(id);
    if (!sub) return false;
    for (const dir of dirs) {
      if (typeof dir !== 'string' || !isInsideRoot(sub.root, dir)) continue;
      this.subscribeDir(sub, dir, { recursive: false });
    }
    return true;
  }

  removeDirs(id: string, dirs: string[]): boolean {
    const sub = this.subs.get(id);
    if (!sub) return false;
    for (const dir of dirs) {
      if (typeof dir !== 'string') continue;
      if (dir === sub.root) continue; // never drop the always-on root watch
      this.unsubscribeDir(sub, dir);
    }
    return true;
  }

  private onChange(sub: Subscription, dir: string, kind: ChangeKind, filename: string) {
    if (sub.closed) return;
    const key = `${dir}\0${kind}`;
    const existing = sub.timers.get(key);
    if (existing) clearTimeout(existing);
    sub.timers.set(key, setTimeout(() => {
      sub.timers.delete(key);
      sub.send(JSON.stringify({
        type: kind === 'vcs' ? 'vcs-change' : 'change',
        dir,
        path: path.join(dir, filename),
        filename,
      }));
    }, kind === 'vcs' ? VCS_DEBOUNCE_MS : FILE_DEBOUNCE_MS));
  }

  close(id: string) {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.closed = true;
    for (const [, unsub] of sub.dirs) { try { unsub(); } catch { /* ignore */ } }
    sub.dirs.clear();
    for (const [, t] of sub.timers) clearTimeout(t);
    sub.timers.clear();
    this.subs.delete(id);
  }
}

// Survive Next.js HMR: GET and POST must share the same live subscriptions.
const globalKey = '__fury_tree_watch_registry__';
const registry: TreeWatchRegistry =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new TreeWatchRegistry());

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  // `root` is the new name; accept legacy `path` for compatibility.
  const root = searchParams.get('root') || searchParams.get('path');

  if (!root) {
    return new Response('Root path is required', { status: 400 });
  }

  try {
    const stats = fs.statSync(root);
    if (!stats.isDirectory()) {
      return new Response('Path is not a directory', { status: 400 });
    }
  } catch {
    return new Response('Directory does not exist', { status: 404 });
  }

  let subscriptionId = '';
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      let torn = false;

      // Unsubscribe ALL of this subscription's dirs (decrementing registry
      // refcounts, closing any watcher no other subscription needs) and drop
      // the registry entry. Idempotent: reachable from abort, stream cancel,
      // and the liveness probe below.
      const release = () => {
        if (torn) return;
        torn = true;
        if (keepAlive) clearInterval(keepAlive);
        registry.close(subscriptionId);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };
      teardown = release;

      const send = (data: string) => {
        if (torn) return;
        try {
          // enqueue() does NOT throw when nobody is reading — it silently grows
          // an internal queue. Without this cap a client that stops draining is
          // an unbounded sink, and because the subscription also pins refcounts
          // on SHARED watchers, it keeps those alive for every other viewer too.
          if (controller.desiredSize !== null && controller.desiredSize < -MAX_QUEUED_CHUNKS) {
            console.warn(`/api/tree/watch: client for ${root} stopped draining; closing`);
            release();
            return;
          }
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      };

      subscriptionId = registry.create(root, send);

      // Tell the client its subscriptionId so it can drive the control channel.
      send(JSON.stringify({ type: 'connected', subscriptionId }));

      // Keep-alive ping every 30s to prevent timeout — and double as a liveness
      // probe. A half-open socket (laptop sleep, Wi-Fi drop, NAT eviction) never
      // emits a FIN, so `request.signal` never aborts and the subscription would
      // otherwise live forever. If our own pings stop being drained, the peer is
      // gone regardless of what the socket claims.
      let stalledPings = 0;
      keepAlive = setInterval(() => {
        if (controller.desiredSize !== null && controller.desiredSize < 0) {
          if (++stalledPings >= MAX_STALLED_PINGS) {
            console.warn(`/api/tree/watch: no reader for ${root} across ` +
              `${MAX_STALLED_PINGS} pings; closing`);
            release();
            return;
          }
        } else {
          stalledPings = 0;
        }
        send(JSON.stringify({ type: 'ping' }));
      }, KEEPALIVE_MS);

      request.signal.addEventListener('abort', release);
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

export async function POST(request: NextRequest) {
  let body: { subscriptionId?: string; add?: string[]; remove?: string[] };
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { subscriptionId, add, remove } = body || {};
  if (!subscriptionId) {
    return new Response('subscriptionId is required', { status: 400 });
  }

  let known = true;
  if (Array.isArray(remove) && remove.length) known = registry.removeDirs(subscriptionId, remove) && known;
  if (Array.isArray(add) && add.length) known = registry.addDirs(subscriptionId, add) && known;

  if (!known) {
    // The subscription is gone (SSE reconnected with a new id) — tell the client
    // so it can re-sync its watched set against the current connection.
    return new Response('Unknown subscriptionId', { status: 404 });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
