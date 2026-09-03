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

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
