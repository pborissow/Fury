import fs from 'fs';
import { existsSync } from 'fs';
import { extname } from 'path';
import { log } from './logger';
import {
  isCodeSearchEnabled,
  codeSearchDbPath,
  codeSearchDirs,
} from './codeSearchConfig';
import { reindexProject } from './codemoggerServer';

/**
 * Auto-reindex the codemogger code-search index when a "This project" (codesearch)
 * project's SELECTED source directories change.
 *
 * codemogger indexes a snapshot — it does NOT watch the filesystem — so the index
 * drifts stale after any edit until something re-indexes. This closes that gap: when
 * an SDK turn runs for a code-search-enabled project we watch its indexed directories
 * and reindex on change, debounced (coalesce a burst of saves) and single-flight
 * (never two reindexes for one project at once). Indexing is incremental +
 * content-hashed inside codemogger, so unchanged files are skipped.
 *
 * IN-PROCESS (docs/ticket-codesearch-inprocess-mcp-macos-contention.md, Option A):
 * the reindex runs via `reindexProject()` in Fury's OWN process against the same
 * `CodeIndex` connection the search tool uses, mutex-serialized so a reindex's FTS
 * DDL never fights a concurrent search. There is NO spawned `codemogger index`
 * process — one process, one DB writer, so the macOS multi-process contention is
 * gone by construction.
 *
 * CONFIG: which dirs to index comes from the project's Fury code-search config
 * (`<project>/.codemogger/fury-codesearch.json`; see lib/codeSearchConfig.ts). The
 * DB is per-project (`<project>/.codemogger/index.db`), so searches never bleed
 * across projects.
 *
 * Shares lib/fileWatchers.ts's scaffolding style (native fs.watch, debounce timers, a
 * globalThis-pinned singleton, stopAll() for shutdown), but recursive: each selected
 * dir gets one `fs.watch(dir, { recursive: true })`.
 *
 * PLATFORM LIMITATION: recursive fs.watch is macOS/Windows only; on Linux it throws
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM. `ensureWatching` no-ops with a single info log
 * on unsupported platforms. (The reindex ITSELF is cross-platform — only the fs.watch
 * *trigger* is gated; a manual/registration-time reindex works everywhere.)
 */

/** Directories whose events never warrant a reindex (build output, VCS, deps). */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', '.cache', '.svelte-kit',
  'dist', 'build', 'out', 'coverage', '.codemogger', '.vercel', 'target',
]);

/** `fs.watch({ recursive: true })` works only on macOS and Windows; on Linux it
 *  throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM. Auto-reindex is gated on this. */
export const RECURSIVE_WATCH_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';

/** File extensions codemogger indexes (its tree-sitter language set). */
export const INDEX_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.rs', '.rb', '.php', '.scala', '.cs', '.zig',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.hh',
]);

/**
 * Should a change to `filename` (the path fs.watch reports, relative to the
 * watched root) trigger a reindex? True only for an indexable source extension
 * that isn't under an ignored directory. Pure — unit-tested directly.
 */
export function isIndexableChange(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const segments = filename.replace(/\\/g, '/').split('/');
  for (const seg of segments) if (IGNORE_DIRS.has(seg)) return false;
  return INDEX_EXT.has(extname(filename).toLowerCase());
}

/** Default reindex: run the in-process engine over the project's selected dirs. */
function defaultReindex(projectPath: string, dbPath: string, dirs: string[]): Promise<void> {
  return reindexProject(projectPath, dbPath, dirs);
}

export class CodemoggerReindexer {
  private watchers = new Map<string, fs.FSWatcher[]>();
  private debounces = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private dirty = new Set<string>();
  private unsupportedWarned = false;
  private readonly debounceMs: number;
  private readonly reindex: (projectPath: string, dbPath: string, dirs: string[]) => Promise<void>;

  constructor(opts: { debounceMs?: number; reindex?: (projectPath: string, dbPath: string, dirs: string[]) => Promise<void> } = {}) {
    this.debounceMs = opts.debounceMs ?? 4000;
    this.reindex = opts.reindex ?? defaultReindex;
  }

  /** Whether any watcher is attached for `projectPath` (test/introspection). */
  isWatching(projectPath: string): boolean {
    return (this.watchers.get(this.key(projectPath))?.length ?? 0) > 0;
  }

  private key(projectPath: string): string {
    return projectPath.replace(/\\/g, '/');
  }

  /**
   * Start watching a code-search-enabled project's SELECTED directories for source
   * changes. Idempotent and best-effort (never throws). Safe to call every turn — a
   * no-op once watching or when code search isn't enabled.
   */
  ensureWatching(projectPath: string): void {
    if (!projectPath) return;
    const key = this.key(projectPath);
    if (this.watchers.has(key)) return;
    if (!isCodeSearchEnabled(projectPath)) return; // code search not enabled here
    if (!RECURSIVE_WATCH_SUPPORTED) {
      // Log ONCE (ensureWatching runs every turn) so it's diagnosable, not a scary
      // per-turn "watch failed". Auto-reindex is simply off on this platform.
      if (!this.unsupportedWarned) {
        this.unsupportedWarned = true;
        log.info('codemogger.reindex', 'auto-reindex unavailable (recursive fs.watch is macOS/Windows only)', {
          data: { platform: process.platform },
        });
      }
      return;
    }
    const dirs = codeSearchDirs(projectPath).filter(d => existsSync(d));
    if (!dirs.length) return;
    const watchers: fs.FSWatcher[] = [];
    for (const dir of dirs) {
      try {
        const w = fs.watch(dir, { recursive: true }, (_evt, filename) => {
          if (isIndexableChange(filename == null ? null : String(filename))) this.scheduleReindex(projectPath);
        });
        w.on('error', () => { try { w.close(); } catch { /* ignore */ } });
        watchers.push(w);
      } catch (err) {
        log.warn('codemogger.reindex', 'watch failed', {
          data: { dir, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    if (!watchers.length) return;
    this.watchers.set(key, watchers);
    log.info('codemogger.reindex', 'watching', { data: { project: projectPath, dirs } });
  }

  /** Debounce a reindex for a project — coalesces a burst of saves into one run. */
  scheduleReindex(projectPath: string): void {
    const key = this.key(projectPath);
    const existing = this.debounces.get(key);
    if (existing) clearTimeout(existing);
    this.debounces.set(key, setTimeout(() => {
      this.debounces.delete(key);
      void this.runReindex(projectPath);
    }, this.debounceMs));
  }

  /**
   * Reindex NOW (bypassing the debounce) — for the registration-time initial index.
   * Still single-flight per project (a concurrent run coalesces via the dirty flag).
   */
  async reindexNow(projectPath: string): Promise<void> {
    await this.runReindex(projectPath);
  }

  /**
   * Run one reindex of all the project's selected dirs, single-flight per project: if
   * one is already running, mark the project dirty and re-run once it finishes (so
   * edits during indexing aren't lost). Re-resolves the config each run so a change
   * (or code-search removal) is honored; if code search is gone, stop watching.
   */
  private async runReindex(projectPath: string): Promise<void> {
    const key = this.key(projectPath);
    if (this.running.has(key)) { this.dirty.add(key); return; }

    if (!isCodeSearchEnabled(projectPath)) { this.stopWatching(projectPath); return; } // disabled
    const dbPath = codeSearchDbPath(projectPath);
    const dirs = codeSearchDirs(projectPath).filter(d => existsSync(d));
    if (!dirs.length) return;

    this.running.add(key);
    try {
      // reindexProject is itself best-effort (logs per-dir failures), but wrap here
      // too so an embedder-load rejection can't escape into the debounce timer.
      await this.reindex(projectPath, dbPath, dirs);
    } catch (err) {
      log.warn('codemogger.reindex', 'reindex failed', {
        data: { project: projectPath, error: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      this.running.delete(key);
      if (this.dirty.delete(key)) this.scheduleReindex(projectPath); // coalesced edits
    }
  }

  stopWatching(projectPath: string): void {
    const key = this.key(projectPath);
    for (const w of this.watchers.get(key) ?? []) { try { w.close(); } catch { /* ignore */ } }
    this.watchers.delete(key);
    const d = this.debounces.get(key);
    if (d) { clearTimeout(d); this.debounces.delete(key); }
    this.dirty.delete(key);
  }

  /** Tear down every watcher + pending debounce. Call on server shutdown. */
  stopAll(): void {
    for (const [, ws] of this.watchers) for (const w of ws) { try { w.close(); } catch { /* ignore */ } }
    this.watchers.clear();
    for (const [, d] of this.debounces) clearTimeout(d);
    this.debounces.clear();
    this.dirty.clear();
  }
}

// Singleton across Next.js HMR, VERSION-GATED. Bump SINGLETON_VERSION when this
// class's behavior changes so a running dev server recreates the instance instead
// of keeping stale method bodies. On recreate, tear down the previous instance's
// watchers first so they don't leak; the next turn re-attaches via ensureWatching.
//   2: per-project DB + selected-directory scoping (sidecar), reindexNow(), per-dir
//      watchers/indexing (ticket-local-mcp... decision #2).
//   3: IN-PROCESS reindex — sources dirs/db from lib/codeSearchConfig and calls
//      reindexProject() in Fury's process instead of spawning `codemogger index`
//      (docs/ticket-codesearch-inprocess-mcp-macos-contention.md, Option A). Without
//      this bump the live instance keeps the old spawn path (the competing process).
const SINGLETON_VERSION = 3;
const globalKey = '__fury_codemogger_reindexer__';
const globalVerKey = '__fury_codemogger_reindexer_v__';
const g = globalThis as any;
if (!g[globalKey] || g[globalVerKey] !== SINGLETON_VERSION) {
  try { g[globalKey]?.stopAll?.(); } catch { /* ignore */ }
  g[globalKey] = new CodemoggerReindexer();
  g[globalVerKey] = SINGLETON_VERSION;
}
export const codemoggerReindexer: CodemoggerReindexer = g[globalKey];
