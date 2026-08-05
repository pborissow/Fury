import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { log } from './logger';

/**
 * Atomic write (P20): write to a temp file in the same directory, then rename over
 * the target. `.mcp.json` is read by other Claude processes and rewritten from two
 * near-simultaneous callers (GET /api/mcp and GET /api/code-search both fire the
 * legacy migration), so a bare writeFileSync can expose a torn/partial file. A
 * rename is atomic on POSIX and replaces atomically on Windows (MoveFileEx). The
 * EPERM/EACCES retry covers a Windows reader transiently holding the destination.
 *
 * The retry is a BOUNDED busy-loop with NO backoff (unlike the async twin in
 * mcpApprove.ts, which awaits a delay): this function is synchronous, so a delay could
 * only be a blocking sleep that stalls the event loop — worse than retrying. It's
 * capped at 10 immediate attempts and POSIX never hits the retry at all (rename over
 * an open file succeeds), so the loop is effectively Windows-only and short.
 */
let atomicTmpCounter = 0;
function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.fury-${process.pid}-${atomicTmpCounter++}.tmp`;
  writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES') && i < 10) continue;
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  }
}

/**
 * "This project" code-search configuration — the IN-PROCESS replacement for the
 * old stdio codemogger `.mcp.json` registration (docs/ticket-codesearch-inprocess-
 * mcp-macos-contention.md, Option A).
 *
 * Code search is no longer a listed MCP server. Instead a small per-project sidecar
 * — `<project>/.codemogger/fury-codesearch.json` = `{ dirs: [...] }` — records that
 * code search is enabled and which directories to index. The index DB lives beside
 * it at `<project>/.codemogger/index.db`, and both search (the SDK in-process tool)
 * and reindex (Fury's watcher) run inside Fury's process against that one DB.
 *
 * All reads here are SYNCHRONOUS and cheap (a single small JSON file) so the SDK
 * session manager can decide, at query-open time, whether to attach the in-process
 * codemogger server — without going async in the hot path.
 */

/** Directory (relative to a project) holding the index DB + this config. */
export const CODESEARCH_SUBDIR = '.codemogger';
/** The Fury code-search config filename inside `.codemogger/`. */
export const CODESEARCH_CONFIG_FILE = 'fury-codesearch.json';
/** Legacy per-project selected-dirs sidecar (next to the old stdio `--db`). */
const LEGACY_INDEX_DIRS_SIDECAR = '.fury-index-dirs.json';

export interface CodeSearchConfig {
  /** Directories to index + watch for this project. */
  dirs: string[];
}

/** The `.codemogger/` directory for a project. */
export function codeSearchDir(projectPath: string): string {
  return join(projectPath, CODESEARCH_SUBDIR);
}

/** The per-project index DB path (`<project>/.codemogger/index.db`). */
export function codeSearchDbPath(projectPath: string): string {
  return join(projectPath, CODESEARCH_SUBDIR, 'index.db');
}

/** The Fury code-search config path (`<project>/.codemogger/fury-codesearch.json`). */
export function codeSearchConfigPath(projectPath: string): string {
  return join(projectPath, CODESEARCH_SUBDIR, CODESEARCH_CONFIG_FILE);
}

/**
 * The project's code-search config, or null if code search isn't enabled there.
 * Pure (reads disk). A present-but-empty `dirs` still counts as enabled (the
 * watcher falls back to the project root).
 */
export function readCodeSearchConfig(projectPath: string): CodeSearchConfig | null {
  if (!projectPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(codeSearchConfigPath(projectPath), 'utf-8'));
    const dirs = Array.isArray(parsed?.dirs)
      ? parsed.dirs.map((d: unknown) => String(d)).filter(Boolean)
      : [];
    return { dirs };
  } catch {
    return null;
  }
}

/** Whether in-process code search is enabled for a project. */
export function isCodeSearchEnabled(projectPath: string): boolean {
  return readCodeSearchConfig(projectPath) !== null;
}

/**
 * The directories to index + watch: the config's `dirs` if non-empty, else the
 * project root (config present but no explicit selection). Empty when code search
 * is disabled.
 */
export function codeSearchDirs(projectPath: string): string[] {
  const cfg = readCodeSearchConfig(projectPath);
  if (!cfg) return [];
  return cfg.dirs.length ? cfg.dirs : [projectPath];
}

/** Enable code search for a project: write its config (creating `.codemogger/`). */
export function writeCodeSearchConfig(projectPath: string, dirs: string[]): void {
  const clean = dirs.map(d => String(d)).filter(Boolean);
  const p = codeSearchConfigPath(projectPath);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify({ dirs: clean }, null, 2) + '\n');
}

/** Disable code search: remove the config file (leaves the DB for a quick re-enable). */
export function removeCodeSearchConfig(projectPath: string): void {
  try {
    rmSync(codeSearchConfigPath(projectPath), { force: true });
  } catch {
    /* already gone */
  }
}

// ── Legacy stdio migration ──────────────────────────────────────────────────────

/** Match a codemogger command by basename (users can rename the SERVER; not the cmd). */
const CODEMOGGER_CMD_RE = /(^|[/\\])codemogger(\.\w+)?$/i;
function isCodemoggerCommand(cmd: string): boolean {
  return CODEMOGGER_CMD_RE.test(cmd) || cmd.toLowerCase() === 'codemogger';
}

/**
 * Remove any stdio codemogger entries from `<project>/.mcp.json`, so the Claude CLI
 * never re-spawns the competing process (acceptance #5). Returns the removed server
 * names. Deletes the file entirely if codemogger was its only content. Best-effort.
 */
export function stripStdioCodemogger(projectPath: string): string[] {
  const mcpPath = join(projectPath, '.mcp.json');
  let cfg: { mcpServers?: Record<string, { command?: unknown }> } & Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'));
  } catch {
    return []; // no/unreadable .mcp.json
  }
  const servers = cfg?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const removed = Object.keys(servers).filter(n => isCodemoggerCommand(String(servers[n]?.command ?? '')));
  if (!removed.length) return [];

  for (const n of removed) delete servers[n];
  try {
    const onlyCodemogger = Object.keys(servers).length === 0 && Object.keys(cfg).length === 1;
    if (onlyCodemogger) {
      rmSync(mcpPath, { force: true });
    } else {
      cfg.mcpServers = servers;
      atomicWriteFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n');
    }
  } catch (err) {
    log.warn('codesearch.migrate', 'failed to strip stdio codemogger entry', {
      data: { projectPath, error: err instanceof Error ? err.message : String(err) },
    });
  }
  return removed;
}

/**
 * Auto-migrate a legacy stdio codemogger `.mcp.json` registration to the in-process
 * model (chosen migration path, 2026-08-02): if the project still has a stdio
 * codemogger entry, carry its selected dirs (from the old `.fury-index-dirs.json`
 * sidecar next to its `--db`) into the new config, then strip the stdio entry.
 *
 * Idempotent + best-effort. Returns true iff it changed anything, so callers can
 * invalidate the MCP cache. Reads the legacy sidecar path inline (rather than
 * importing lib/codemoggerReindex) to avoid a circular import.
 */
export function migrateStdioCodemogger(projectPath: string): boolean {
  if (!projectPath) return false;
  const mcpPath = join(projectPath, '.mcp.json');
  let cfg: { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
  try {
    cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'));
  } catch {
    return false;
  }
  const servers = cfg?.mcpServers;
  if (!servers || typeof servers !== 'object') return false;
  const names = Object.keys(servers).filter(n => isCodemoggerCommand(String(servers[n]?.command ?? '')));
  if (!names.length) return false;

  // Carry over the selected dirs, but never clobber an existing in-process config.
  if (!isCodeSearchEnabled(projectPath)) {
    let dirs: string[] = [projectPath];
    const rawArgs = servers[names[0]]?.args;
    const args = Array.isArray(rawArgs) ? rawArgs.map(a => String(a)) : [];
    const i = args.indexOf('--db');
    const dbPath = i !== -1 && args[i + 1] ? args[i + 1] : null;
    if (dbPath) {
      try {
        const sidecar = JSON.parse(readFileSync(join(dirname(dbPath), LEGACY_INDEX_DIRS_SIDECAR), 'utf-8'));
        const sd = Array.isArray(sidecar?.dirs) ? sidecar.dirs.map((d: unknown) => String(d)).filter(Boolean) : [];
        if (sd.length) dirs = sd;
      } catch {
        /* no sidecar → default to the project root */
      }
    }
    writeCodeSearchConfig(projectPath, dirs);
  }

  const removed = stripStdioCodemogger(projectPath);
  log.info('codesearch.migrate', 'migrated stdio codemogger → in-process', {
    data: { projectPath, removed },
  });
  return true;
}

/** True if the project has a code-search DB on disk (for a quick "already indexed" check). */
export function hasIndexDb(projectPath: string): boolean {
  return existsSync(codeSearchDbPath(projectPath));
}
