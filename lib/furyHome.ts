/**
 * Fury's dedicated data home: `~/.fury` (override via FURY_HOME).
 *
 * Single source of truth for every Fury-OWNED persistent path. Historically
 * Fury's data was scattered across three homes — Anthropic's `~/.claude`
 * (fury.db, fury-images/, fury-logs/, provider-fallback-log.jsonl), a `$HOME`
 * sibling (`~/.claude-session-notes`), and `$cwd` (.claude-ui-state,
 * .claude-prompts, .claude-workflows). That was self-defeating (the archive DB
 * backing up `~/.claude` lived INSIDE `~/.claude`) and fragile (launch from a
 * different cwd → "reset" settings). See docs/plan-fury-home-migration.md.
 *
 * Layout under FURY_HOME:
 *   fury.db                         transcript archive DB
 *   images/<sessionId>/<hash>.<ext> image store
 *   logs/                           daily JSONL logs
 *   provider-fallback-log.jsonl     provider-switch audit log
 *   notes/<slug>.md                 per-project session notes
 *   state/settings.json             app settings
 *   state/ui-state.json             UI layout/view state
 *   state/prompts/                  prompt templates
 *   state/workflows/                saved workflows
 *   internal/<name>/                stealth-session cwds (lib/stealthSessions.ts)
 *   .migrated                       one-time migration marker
 *
 * Precedence: specific overrides (FURY_DB_PATH, FURY_IMAGES_PATH) beat the
 * FURY_HOME umbrella, which beats the `~/.fury` default — so tests keep
 * pointing individual stores at scratch locations.
 *
 * Read-fallback (transitional, drop after a release): if the new location is
 * absent but the legacy one exists — a failed or skipped migration — resolvers
 * return the legacy path, so a partial migration never presents as data loss.
 * The migration (lib/furyHomeMigration.ts) retries on every boot until it
 * completes cleanly, at which point the legacy locations are empty.
 *
 * IMPORTANT: resolve paths lazily (at call time, not module-import time).
 * Modules load before the startup migration runs; a path captured at import
 * time could point at a legacy location that the migration is about to move.
 *
 * Claude-Code-owned paths (~/.claude/projects, history.jsonl, sessions/,
 * .credentials.json, settings.json, plans/, ~/.claude.json) deliberately do
 * NOT live here — Fury interoperates with those in place.
 */

import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';

/** Root of Fury's data home. */
export function furyHome(): string {
  return process.env.FURY_HOME || join(homedir(), '.fury');
}

/** A path under the Fury home. */
export function furyPath(...parts: string[]): string {
  return join(furyHome(), ...parts);
}

/**
 * Legacy (pre-`~/.fury`) locations. Used by the one-time migration and the
 * transitional read-fallback below. Functions (not consts) so tests can mock
 * os.homedir / process.cwd and so nothing is captured at import time.
 */
export const legacyPaths = {
  dbFile: () => join(homedir(), '.claude', 'fury.db'),
  imagesRoot: () => join(homedir(), '.claude', 'fury-images'),
  logsDir: () => join(homedir(), '.claude', 'fury-logs'),
  providerFallbackLog: () => join(homedir(), '.claude', 'provider-fallback-log.jsonl'),
  notesDir: () => join(homedir(), '.claude-session-notes'),
  uiStateDir: () => join(process.cwd(), '.claude-ui-state'),
  promptsDir: () => join(process.cwd(), '.claude-prompts'),
  workflowsDir: () => join(process.cwd(), '.claude-workflows'),
};

/** New path if it exists; else the legacy path if THAT exists; else the new. */
function withLegacyFallback(newPath: string, legacyPath: string): string {
  if (existsSync(newPath)) return newPath;
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}

/** Archive DB file. FURY_DB_PATH (explicit override) always wins. */
export function furyDbPath(): string {
  return process.env.FURY_DB_PATH
    || withLegacyFallback(furyPath('fury.db'), legacyPaths.dbFile());
}

/** Image-store root. FURY_IMAGES_PATH (explicit override) always wins. */
export function furyImagesRoot(): string {
  return process.env.FURY_IMAGES_PATH
    || withLegacyFallback(furyPath('images'), legacyPaths.imagesRoot());
}

/** Daily-JSONL log directory. */
export function furyLogsDir(): string {
  return withLegacyFallback(furyPath('logs'), legacyPaths.logsDir());
}

/** Append-only provider-switch audit log. */
export function furyProviderFallbackLogPath(): string {
  return withLegacyFallback(
    furyPath('provider-fallback-log.jsonl'),
    legacyPaths.providerFallbackLog(),
  );
}

/** Per-project session-notes directory. */
export function furyNotesDir(): string {
  return withLegacyFallback(furyPath('notes'), legacyPaths.notesDir());
}

/** Settings file (was $cwd/.claude-ui-state/settings.json). */
export function furySettingsFile(): string {
  return withLegacyFallback(
    furyPath('state', 'settings.json'),
    join(legacyPaths.uiStateDir(), 'settings.json'),
  );
}

/** UI-state file (was $cwd/.claude-ui-state/state.json — note the rename). */
export function furyUiStateFile(): string {
  return withLegacyFallback(
    furyPath('state', 'ui-state.json'),
    join(legacyPaths.uiStateDir(), 'state.json'),
  );
}

/** Prompt-template directory (was $cwd/.claude-prompts). */
export function furyPromptsDir(): string {
  return withLegacyFallback(furyPath('state', 'prompts'), legacyPaths.promptsDir());
}

/** Saved-workflow directory (was $cwd/.claude-workflows). */
export function furyWorkflowsDir(): string {
  return withLegacyFallback(furyPath('state', 'workflows'), legacyPaths.workflowsDir());
}

// ---------------------------------------------------------------------------
// Stealth sessions — the hiding contract (docs/ticket-stealth-sessions.md §2).
//
// A stealth session's cwd is `<FURY_HOME>/internal/<name>/`. That path prefix
// is THE marker every user-facing surface tests (archiver, live set, history,
// orphan sweep) — no per-surface id lists to keep in sync, and a crashed
// server's leftovers are re-identifiable from the cwd in their PID file alone.
// ---------------------------------------------------------------------------

/** Consumer names become a path segment AND a Stats label: keep them boring. */
const INTERNAL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidInternalName(name: string): boolean {
  return INTERNAL_NAME_RE.test(name);
}

/** Root of the reserved subtree: `<FURY_HOME>/internal`. */
export function furyInternalRoot(): string {
  return furyPath('internal');
}

/** The reserved cwd for stealth consumer `name`. Throws on an unsafe name. */
export function furyInternalPath(name: string): string {
  if (!isValidInternalName(name)) {
    throw new Error(`Invalid stealth-session name "${name}" (want ${INTERNAL_NAME_RE})`);
  }
  return join(furyInternalRoot(), name);
}

/** Case-fold where the filesystem usually does (macOS, Windows) so a path that
 *  differs only in case can't slip past the filter. Over-matching here only
 *  hides more of Fury's own reserved subtree, so folding is the safe direction. */
function normForCompare(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
}

/**
 * Is `projectPath` inside the reserved internal subtree? Cheap and sync — it is
 * called per entry on hot paths (PID scan, history listing, archiving).
 * Null/empty/non-string → false.
 */
export function isInternalProject(projectPath: string | null | undefined): boolean {
  if (typeof projectPath !== 'string' || !projectPath) return false;
  const root = normForCompare(furyInternalRoot());
  const p = normForCompare(projectPath);
  return p === root || p.startsWith(root + sep);
}

/**
 * Every comparable form of a path: resolved + case-folded (the form
 * isInternalProject uses) and, when the path exists, its realpath too (catches
 * a symlinked FURY_HOME, macOS /var → /private/var, a CLI that canonicalized
 * the cwd it recorded). For SAFETY checks that must err toward a match.
 */
export function pathKeys(p: string): string[] {
  const keys = new Set([normForCompare(p)]);
  try { keys.add(normForCompare(realpathSync(p))); } catch { /* missing — lexical key only */ }
  return [...keys];
}

/**
 * Is `child` the same as, or beneath, `parent` under ANY of their comparable
 * forms? Errs toward true, which is the safe answer when the caller is about
 * to delete something only if it's NOT in use.
 */
export function isSameOrUnderLoose(child: string, parent: string): boolean {
  const ck = pathKeys(child);
  return pathKeys(parent).some((pk) => ck.some((c) => c === pk || c.startsWith(pk + sep)));
}
