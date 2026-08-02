import fs from 'fs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join, dirname, extname } from 'path';
import { log } from './logger';

/**
 * Auto-reindex the codemogger code-search DB when a "This project" (codesearch)
 * project's SELECTED source directories change.
 *
 * codemogger serves the SQLite index as a static snapshot — it does NOT watch the
 * filesystem, and Fury never reindexes on its own, so the index drifts stale after
 * any edit until something calls `codemogger_index`/`reindex`. This closes that gap:
 * when an SDK turn runs for a codemogger-configured project we watch its indexed
 * directories and run `codemogger --db <db> index <dir>` per dir — debounced (coalesce
 * a burst of saves) and single-flight (never two indexes for one project at once).
 * Indexing is incremental + content-hashed inside codemogger, so unchanged files are
 * skipped.
 *
 * SELECTED DIRECTORIES: the wizard lets the user choose which directories to index;
 * Fury records them in a per-project sidecar (`<db-dir>/.fury-index-dirs.json`) next
 * to the DB. We watch and reindex exactly those dirs (falling back to the project root
 * for older registrations with no sidecar). The DB itself is per-project
 * (`<project>/.codemogger/index.db`), so searches never bleed across projects.
 *
 * Shares lib/fileWatchers.ts's scaffolding style (native fs.watch, debounce timers, a
 * globalThis-pinned singleton, stopAll() for shutdown), but recursive: each selected
 * dir gets one `fs.watch(dir, { recursive: true })`.
 *
 * PLATFORM LIMITATION: recursive fs.watch is macOS/Windows only; on Linux it throws
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM. `ensureWatching` no-ops with a single info log
 * on unsupported platforms. (A cross-platform version would walk with per-dir
 * non-recursive watchers, or add chokidar.)
 */

/** Sidecar (next to the per-project DB) recording which dirs to watch + index. */
export const INDEX_DIRS_SIDECAR = '.fury-index-dirs.json';

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

/**
 * The `--db` path of the project's codemogger stdio server from `<project>/.mcp.json`,
 * or null if the project has no codemogger server configured. Falls back to the
 * default `~/.codemogger/index.db` if a codemogger server exists without an explicit
 * `--db`. Pure (reads disk) — unit-tested against a temp .mcp.json.
 */
export function readCodemoggerDbPath(projectPath: string): string | null {
  const mcpPath = join(projectPath, '.mcp.json');
  let cfg: { mcpServers?: Record<string, { command?: string; args?: unknown }> };
  try {
    cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'));
  } catch {
    return null;
  }
  const servers = cfg?.mcpServers ?? {};
  for (const server of Object.values(servers)) {
    const cmd = String(server?.command ?? '');
    // Match the command basename, not the server name (users can rename it).
    if (!/(^|[/\\])codemogger(\.\w+)?$/i.test(cmd) && cmd.toLowerCase() !== 'codemogger') continue;
    const args = Array.isArray(server?.args) ? server!.args.map(a => String(a)) : [];
    const i = args.indexOf('--db');
    if (i !== -1 && i + 1 < args.length && args[i + 1]) return args[i + 1];
    return join(homedir(), '.codemogger', 'index.db'); // codemogger default
  }
  return null;
}

/** The sidecar path for a given `--db` path (sits next to the DB). */
function sidecarPathForDb(dbPath: string): string {
  return join(dirname(dbPath), INDEX_DIRS_SIDECAR);
}

/** Record the selected index directories in the sidecar next to `dbPath`. */
export function writeIndexDirs(dbPath: string, dirs: string[]): void {
  const clean = dirs.map(d => String(d)).filter(Boolean);
  try {
    writeFileSync(sidecarPathForDb(dbPath), JSON.stringify({ dirs: clean }, null, 2));
  } catch (err) {
    log.warn('codemogger.reindex', 'failed to write index-dirs sidecar', {
      data: { dbPath, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * The directories to watch + index for a project: the sidecar's `dirs` if present,
 * else the project root (older registrations / no explicit selection). Empty when
 * the project has no codemogger server. Pure (reads disk).
 */
export function readIndexDirs(projectPath: string): string[] {
  const dbPath = readCodemoggerDbPath(projectPath);
  if (!dbPath) return [];
  try {
    const parsed = JSON.parse(readFileSync(sidecarPathForDb(dbPath), 'utf-8'));
    const dirs = Array.isArray(parsed?.dirs) ? parsed.dirs.map((d: unknown) => String(d)).filter(Boolean) : [];
    if (dirs.length) return dirs;
  } catch { /* no sidecar — fall back to the project root */ }
  return [projectPath];
}

/** Run `codemogger --db <db> index <dir>` via node against the repo's own codemogger
 *  cli.mjs (portable — the Windows `.cmd` PATH shim isn't execFile-able by bare name,
 *  and a `shell:true` fallback wouldn't quote spaced paths). If the cli isn't present,
 *  warn and skip rather than spawn something fragile. */
function defaultRunIndex(dir: string, dbPath: string): Promise<void> {
  return new Promise((resolve) => {
    const cli = join(process.cwd(), 'node_modules', 'codemogger', 'dist', 'cli.mjs');
    if (!existsSync(cli)) {
      log.warn('codemogger.reindex', 'codemogger cli not found; skipping reindex', { data: { cli } });
      resolve();
      return;
    }
    execFile(process.execPath, [cli, '--db', dbPath, 'index', dir], { timeout: 5 * 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        log.warn('codemogger.reindex', 'index failed', {
          data: { dir, error: err.message, stderr: String(stderr || '').slice(0, 300) },
        });
      } else {
        const summary = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
        log.info('codemogger.reindex', 'indexed', { data: { dir, summary: summary.slice(0, 200) } });
      }
      resolve();
    });
  });
}

export class CodemoggerReindexer {
  private watchers = new Map<string, fs.FSWatcher[]>();
  private debounces = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private dirty = new Set<string>();
  private unsupportedWarned = false;
  private readonly debounceMs: number;
  private readonly runIndex: (dir: string, dbPath: string) => Promise<void>;

  constructor(opts: { debounceMs?: number; runIndex?: (dir: string, db: string) => Promise<void> } = {}) {
    this.debounceMs = opts.debounceMs ?? 4000;
    this.runIndex = opts.runIndex ?? defaultRunIndex;
  }

  /** Whether any watcher is attached for `projectPath` (test/introspection). */
  isWatching(projectPath: string): boolean {
    return (this.watchers.get(this.key(projectPath))?.length ?? 0) > 0;
  }

  private key(projectPath: string): string {
    return projectPath.replace(/\\/g, '/');
  }

  /**
   * Start watching a codemogger-configured project's SELECTED directories for source
   * changes. Idempotent and best-effort (never throws). Safe to call every turn — a
   * no-op once watching or when codemogger isn't configured.
   */
  ensureWatching(projectPath: string): void {
    if (!projectPath) return;
    const key = this.key(projectPath);
    if (this.watchers.has(key)) return;
    if (!readCodemoggerDbPath(projectPath)) return; // no codemogger server here
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
    const dirs = readIndexDirs(projectPath).filter(d => existsSync(d));
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
   * edits during indexing aren't lost). Re-resolves the `--db` + dirs each run so a
   * config change (or codemogger removal) is honored; if codemogger is gone, stop.
   */
  private async runReindex(projectPath: string): Promise<void> {
    const key = this.key(projectPath);
    if (this.running.has(key)) { this.dirty.add(key); return; }

    const dbPath = readCodemoggerDbPath(projectPath);
    if (!dbPath) { this.stopWatching(projectPath); return; } // codemogger removed
    const dirs = readIndexDirs(projectPath).filter(d => existsSync(d));

    this.running.add(key);
    try {
      for (const dir of dirs) await this.runIndex(dir, dbPath);
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
// of keeping stale method bodies (a plain `globalThis[key] ?? new` would keep the
// old instance forever — e.g. missing `reindexNow`, or the pre-selected-dirs
// `runReindex`). On recreate, tear down the previous instance's watchers first so
// they don't leak; the next turn re-attaches via ensureWatching.
//   2: per-project DB + selected-directory scoping (sidecar), reindexNow(), per-dir
//      watchers/indexing (ticket-local-mcp... decision #2).
const SINGLETON_VERSION = 2;
const globalKey = '__fury_codemogger_reindexer__';
const globalVerKey = '__fury_codemogger_reindexer_v__';
const g = globalThis as any;
if (!g[globalKey] || g[globalVerKey] !== SINGLETON_VERSION) {
  try { g[globalKey]?.stopAll?.(); } catch { /* ignore */ }
  g[globalKey] = new CodemoggerReindexer();
  g[globalVerKey] = SINGLETON_VERSION;
}
export const codemoggerReindexer: CodemoggerReindexer = g[globalKey];
