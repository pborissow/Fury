import fs from 'fs';
import { classifyChange, type ChangeKind } from './fileTree';

/**
 * Ref-counted, keyed `fs.watch` registry for the Files tab.
 *
 * WHY THIS EXISTS: Fury allows multiple sessions (and the Source Control dialog)
 * to view the SAME project root at once. Previously each surface opened its own
 * `fs.watch`, so N views of one folder meant N OS-level watchers on it — all
 * redundant. This registry keys watchers by absolute directory path so a given
 * directory is watched at most ONCE, no matter how many callers subscribe; the
 * last subscriber to leave closes the underlying watcher.
 *
 * Modeled on lib/fileWatchers.ts (ref counting) and lib/codemoggerReindex.ts
 * (per-directory native watchers + globalThis-pinned singleton for HMR).
 *
 * Each watched directory is either:
 *  - a plain tree folder, watched NON-recursively (only its immediate entries),
 *    because the tree is lazy-loaded per level; or
 *  - a VCS metadata dir (`<root>/.git` / `<root>/.svn`, or a linked worktree's
 *    resolved gitdir), watched RECURSIVELY so nested index/refs/HEAD writes
 *    (commit, stage, branch switch) are seen. That dir is tiny relative to the
 *    tree, so a recursive watch on it alone is cheap.
 */

export type TreeChangeCallback = (kind: ChangeKind, filename: string) => void;

export interface WatchOptions {
  /** Recursive watch — only for VCS metadata dirs. */
  recursive?: boolean;
  /**
   * A prefix prepended (before a `/`) to each reported filename before it is
   * classified. A watch attached DIRECTLY on a VCS metadata dir reports paths
   * relative to that dir (e.g. "refs/heads/main"), stripped of the ".git"/".svn"
   * segment classifyChange keys on — so pass '.git' or '.svn' to route those
   * events to 'vcs'. (Must be the literal metadata name, not the watched dir's
   * basename: a linked worktree's gitdir is named after the worktree, not
   * ".git".) Omit for plain folders.
   */
  classifyPrefix?: string;
}

/** How many times to retry re-attaching a watcher after it errors before giving
 *  up and dropping the entry (subscribers can re-subscribe to re-establish). */
const MAX_REARM_RETRIES = 3;

interface Entry {
  watcher: fs.FSWatcher | null;
  subscribers: Set<TreeChangeCallback>;
  recursive: boolean;
  /** '' for a plain folder, else '.git/' or '.svn/'. */
  metaPrefix: string;
  rearmRetries: number;
  rearmTimer: ReturnType<typeof setTimeout> | null;
}

class TreeWatchers {
  private entries = new Map<string, Entry>();

  /**
   * Subscribe to changes under `dir`. The first subscriber creates the watcher;
   * subsequent subscribers on the same `dir` share it. Returns an unsubscribe
   * function; when the last subscriber unsubscribes the watcher is closed.
   *
   * Best-effort: if `fs.watch` throws (dir vanished, platform limitation) the
   * returned unsubscribe is a no-op and no events fire.
   */
  watch(dir: string, opts: WatchOptions, onChange: TreeChangeCallback): () => void {
    let entry = this.entries.get(dir);

    if (entry) {
      // A given absolute dir is always subscribed with the same mode in this
      // codebase (a `.git`/`.svn` path never overlaps a listed folder — they're
      // in IGNORED_ITEMS). Guard the invariant in dev so a future caller that
      // breaks it is caught instead of silently inheriting the first mode.
      if (process.env.NODE_ENV !== 'production') {
        const wantPrefix = opts.classifyPrefix ? opts.classifyPrefix + '/' : '';
        if (entry.recursive !== !!opts.recursive || entry.metaPrefix !== wantPrefix) {
          console.warn(
            `[treeWatchers] "${dir}" re-subscribed with different options; ` +
            `keeping the original (recursive=${entry.recursive}, prefix="${entry.metaPrefix}")`,
          );
        }
      }
    } else {
      entry = {
        watcher: null,
        subscribers: new Set(),
        recursive: !!opts.recursive,
        metaPrefix: opts.classifyPrefix ? opts.classifyPrefix + '/' : '',
        rearmRetries: 0,
        rearmTimer: null,
      };
      const watcher = this.createWatcher(dir, entry);
      entry.watcher = watcher;
      this.entries.set(dir, entry);

      if (!watcher) {
        // Could not attach yet — commonly EMFILE under descriptor pressure
        // (macOS defaults are low), or the dir is mid-rename.
        //
        // Do NOT hand back a no-op handle: callers record the handle and then
        // skip re-subscribing that dir, so a transient failure would silently
        // disable it for the life of the connection. Keep the entry and retry
        // with the same backoff used for a watcher that dies later. The retry
        // is deferred by a timer, so the subscriber added below is already in
        // place when it runs (rearm drops an entry with no subscribers).
        entry.rearmRetries = 1;
        entry.rearmTimer = setTimeout(() => this.rearm(dir), 1000);
      }
    }

    entry.subscribers.add(onChange);

    return () => {
      const e = this.entries.get(dir);
      if (!e) return;
      e.subscribers.delete(onChange);
      if (e.subscribers.size === 0) {
        this.dropEntry(dir, e);
      }
    };
  }

  /** Create (or re-create) the underlying fs.watch for an entry, wiring the
   *  fan-out and an error handler that re-arms. Returns null if it can't attach. */
  private createWatcher(dir: string, entry: Entry): fs.FSWatcher | null {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { recursive: entry.recursive }, (_evt, filename) => {
        if (!filename) return;
        // fs.watch may report `filename` as a Buffer depending on platform/encoding.
        const rel = String(filename);
        const kind = classifyChange(entry.metaPrefix + rel);
        if (!kind) return;
        // Snapshot before fan-out: a callback may unsubscribe during dispatch.
        for (const cb of [...entry.subscribers]) {
          try { cb(kind, rel); } catch { /* a subscriber throwing must not stop the rest */ }
        }
      });
    } catch {
      return null;
    }
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* ignore */ }
      this.rearm(dir);
    });
    return watcher;
  }

  /**
   * A watcher died (dir renamed/deleted, or a transient glitch). Try to
   * re-attach WITHOUT dropping the still-live subscribers — otherwise every
   * co-subscriber sharing this dir would silently stop receiving events. Retries
   * with linear backoff; gives up (and drops the entry so a fresh subscribe can
   * re-establish) after MAX_REARM_RETRIES.
   */
  private rearm(dir: string): void {
    const entry = this.entries.get(dir);
    if (!entry) return;
    if (entry.subscribers.size === 0) {
      this.dropEntry(dir, entry);
      return;
    }
    const watcher = this.createWatcher(dir, entry);
    if (watcher) {
      entry.watcher = watcher;
      entry.rearmRetries = 0;
      return;
    }
    if (entry.rearmRetries >= MAX_REARM_RETRIES) {
      // Truly gone — drop it. Subscribers keep their (now no-op) unsub handles;
      // the surface re-establishes the watch on its next mount/expand.
      this.dropEntry(dir, entry);
      return;
    }
    entry.rearmRetries++;
    entry.rearmTimer = setTimeout(() => this.rearm(dir), 1000 * entry.rearmRetries);
  }

  private dropEntry(dir: string, entry: Entry): void {
    if (entry.rearmTimer) { clearTimeout(entry.rearmTimer); entry.rearmTimer = null; }
    try { entry.watcher?.close(); } catch { /* ignore */ }
    this.entries.delete(dir);
  }

  /** How many distinct directories are currently watched (test/introspection). */
  watchedDirCount(): number {
    return this.entries.size;
  }

  /** Subscriber count for a directory — 0 if not watched (test/introspection). */
  subscriberCount(dir: string): number {
    return this.entries.get(dir)?.subscribers.size ?? 0;
  }

  /** Whether `dir` is currently subscribed (test/introspection). Note this is
   *  true while an entry is between rearm attempts, i.e. registered but not
   *  attached; use `isAttached` when that distinction matters. */
  isWatching(dir: string): boolean {
    return this.entries.has(dir);
  }

  /** Whether `dir` has a live OS-level watcher right now (test/introspection). */
  isAttached(dir: string): boolean {
    return !!this.entries.get(dir)?.watcher;
  }

  /** Close every watcher. Call on server shutdown. */
  stopAll(): void {
    for (const [dir, e] of [...this.entries]) {
      this.dropEntry(dir, e);
    }
    this.entries.clear();
  }
}

// Singleton across Next.js HMR (same pattern as lib/fileWatchers.ts).
const globalKey = '__fury_tree_watchers__';
export const treeWatchers: TreeWatchers =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new TreeWatchers());
