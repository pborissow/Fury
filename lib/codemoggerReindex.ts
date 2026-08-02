import fs from 'fs';
import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join, extname } from 'path';
import { log } from './logger';

/**
 * Auto-reindex the codemogger code-search DB when a "This project" (codesearch)
 * project's source files change.
 *
 * codemogger serves the SQLite index as a static snapshot — it does NOT watch the
 * filesystem, and Fury never reindexes on its own, so the index drifts stale after
 * any edit until something calls `codemogger_index`/`reindex` (which rides on the
 * model choosing to). This module closes that gap: when an SDK turn runs for a
 * project that has a codemogger stdio server configured, we watch the project's
 * source tree and run `codemogger --db <db> index <project>` — debounced (coalesce
 * a burst of saves) and single-flight (never two indexes for one project at once).
 * Indexing is incremental + content-hashed inside codemogger, so a no-op edit is
 * cheap and unchanged files are skipped.
 *
 * Shares lib/fileWatchers.ts's scaffolding style (native fs.watch, debounce timers,
 * a globalThis-pinned singleton, stopAll() for shutdown) but — unlike fileWatchers,
 * which watches single files / one directory non-recursively — this needs the whole
 * source tree, so it uses ONE `fs.watch(project, { recursive: true })`.
 *
 * PLATFORM LIMITATION: recursive fs.watch is supported only on macOS and Windows;
 * on Linux it throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM. Auto-reindex is therefore
 * a Windows/macOS feature (Fury's dev target). `ensureWatching` no-ops with a single
 * info log on unsupported platforms rather than failing. A cross-platform version
 * would walk the tree with per-directory non-recursive watchers (or add chokidar).
 *
 * PERF: the recursive watch root is the whole project, so the OS also delivers
 * events for `node_modules`/`.git`/build output. `isIndexableChange` filters those
 * at the callback (no spurious reindex), but the native event volume is wasted work
 * on a large repo — a future optimization is to watch a narrower source-dir set.
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

/** Run `codemogger --db <db> index <project>` via node against the repo's own
 *  codemogger cli.mjs (portable — the Windows `.cmd` PATH shim isn't execFile-able
 *  by bare name, and a `shell:true` fallback wouldn't quote spaced paths). If the
 *  cli isn't present, warn and skip rather than spawn something fragile. */
function defaultRunIndex(projectPath: string, dbPath: string): Promise<void> {
  return new Promise((resolve) => {
    const cli = join(process.cwd(), 'node_modules', 'codemogger', 'dist', 'cli.mjs');
    if (!existsSync(cli)) {
      log.warn('codemogger.reindex', 'codemogger cli not found; skipping reindex', { data: { cli } });
      resolve();
      return;
    }
    execFile(process.execPath, [cli, '--db', dbPath, 'index', projectPath], { timeout: 5 * 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        log.warn('codemogger.reindex', 'index failed', {
          data: { project: projectPath, error: err.message, stderr: String(stderr || '').slice(0, 300) },
        });
      } else {
        // codemogger prints e.g. "Indexed N files → M chunks, embedded …".
        const summary = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
        log.info('codemogger.reindex', 'indexed', {
          data: { project: projectPath, summary: summary.slice(0, 200) },
        });
      }
      resolve();
    });
  });
}

export class CodemoggerReindexer {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounces = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private dirty = new Set<string>();
  private unsupportedWarned = false;
  private readonly debounceMs: number;
  private readonly runIndex: (projectPath: string, dbPath: string) => Promise<void>;

  constructor(opts: { debounceMs?: number; runIndex?: (p: string, db: string) => Promise<void> } = {}) {
    this.debounceMs = opts.debounceMs ?? 4000;
    this.runIndex = opts.runIndex ?? defaultRunIndex;
  }

  /** Whether a watcher is currently attached for `projectPath` (test/introspection). */
  isWatching(projectPath: string): boolean {
    return this.watchers.has(this.key(projectPath));
  }

  private key(projectPath: string): string {
    return projectPath.replace(/\\/g, '/');
  }

  /**
   * Start watching `projectPath` for source changes iff it has a codemogger server
   * configured. Idempotent and best-effort (never throws to the caller). Safe to
   * call on every turn — a no-op once watching or when codemogger isn't configured.
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
    if (!existsSync(projectPath)) return;
    try {
      const watcher = fs.watch(projectPath, { recursive: true }, (_evt, filename) => {
        if (isIndexableChange(filename == null ? null : String(filename))) this.scheduleReindex(projectPath);
      });
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(key);
      });
      this.watchers.set(key, watcher);
      log.info('codemogger.reindex', 'watching', { data: { project: projectPath } });
    } catch (err) {
      log.warn('codemogger.reindex', 'watch failed', {
        data: { project: projectPath, error: err instanceof Error ? err.message : String(err) },
      });
    }
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
   * Run one reindex, single-flight per project: if one is already running, mark the
   * project dirty and re-run once it finishes (so edits during indexing aren't lost).
   * Re-resolves the `--db` each run so a config change (or codemogger removal) is
   * honored; if codemogger is gone, stop watching.
   */
  private async runReindex(projectPath: string): Promise<void> {
    const key = this.key(projectPath);
    if (this.running.has(key)) { this.dirty.add(key); return; }

    const dbPath = readCodemoggerDbPath(projectPath);
    if (!dbPath) { this.stopWatching(projectPath); return; } // codemogger removed

    this.running.add(key);
    try {
      await this.runIndex(projectPath, dbPath);
    } finally {
      this.running.delete(key);
      if (this.dirty.delete(key)) this.scheduleReindex(projectPath); // coalesced edits
    }
  }

  stopWatching(projectPath: string): void {
    const key = this.key(projectPath);
    const w = this.watchers.get(key);
    if (w) { w.close(); this.watchers.delete(key); }
    const d = this.debounces.get(key);
    if (d) { clearTimeout(d); this.debounces.delete(key); }
    this.dirty.delete(key);
  }

  /** Tear down every watcher + pending debounce. Call on server shutdown. */
  stopAll(): void {
    for (const [, w] of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers.clear();
    for (const [, d] of this.debounces) clearTimeout(d);
    this.debounces.clear();
    this.dirty.clear();
  }
}

// Singleton with globalThis protection for Next.js HMR (mirrors fileWatchers).
const globalKey = '__fury_codemogger_reindexer__';
export const codemoggerReindexer: CodemoggerReindexer =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new CodemoggerReindexer());
