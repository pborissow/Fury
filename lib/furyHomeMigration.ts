/**
 * One-time migration of Fury-owned data into `~/.fury` (FURY_HOME).
 *
 * Invoked once at server startup (server.ts) BEFORE anything opens the DB or a
 * persister reads, so every resolver in lib/furyHome.ts sees fully-moved data.
 * See docs/plan-fury-home-migration.md §5 for the design.
 *
 * Properties:
 *  - Idempotent. Guarded by a `.migrated` marker; each per-item move is itself
 *    a no-op when the source is gone or the destination already exists, so a
 *    partial run can safely re-run on the next boot.
 *  - Marker is written LAST, and only when every item succeeded — a failed item
 *    keeps the marker absent so the next boot retries, while the resolvers'
 *    read-fallback keeps the un-moved data reachable in the meantime.
 *  - rename() first (atomic, O(1) — all sources live under $HOME with the
 *    destination, so same-filesystem is the overwhelmingly common case); on a
 *    cross-device EXDEV, falls back to copy → verify(size) → delete. The source
 *    is never deleted until the copy is verified.
 *  - Override-aware: items whose explicit env override is set (FURY_DB_PATH,
 *    FURY_IMAGES_PATH) are skipped entirely — the user already chose a home
 *    for them.
 *  - Lockfile (`.migrating` dir, atomic mkdir) so two concurrently-starting
 *    Fury instances don't both migrate. The loser skips; read-fallback covers
 *    it until its next boot.
 *
 * Uses console.* (not lib/logger) deliberately: the logger's own directory is
 * one of the things being moved.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { furyHome, furyPath, legacyPaths } from './furyHome';

/** Bump if a future release adds migration steps that must re-run. */
const MIGRATION_VERSION = 1;

/** Consider a lock stale (crashed migrator) after this long. */
const LOCK_STALE_MS = 10 * 60 * 1000;

export interface MigrationResult {
  ran: boolean;
  moved: string[];
  failed: string[];
}

function markerPath(): string {
  return furyPath('.migrated');
}

/** Move one file. No-op when src is absent; never clobbers an existing dest. */
function moveFile(src: string, dest: string, moved: string[]): void {
  if (!existsSync(src)) return;
  if (existsSync(dest)) {
    console.warn(`[fury-home] both old and new exist, keeping new: ${src}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Cross-device: copy → verify → delete. Never remove src unverified.
    copyFileSync(src, dest);
    if (statSync(dest).size !== statSync(src).size) {
      rmSync(dest, { force: true });
      throw new Error(`copy verification failed for ${src}`);
    }
    unlinkSync(src);
  }
  moved.push(`${src} -> ${dest}`);
}

/**
 * Move a directory. Whole-dir rename when the destination is absent; when it
 * already exists (e.g. the logger created the new logs dir first), merge
 * entry-by-entry, keeping any destination entry that already exists. Removes
 * the source dir afterwards only if it emptied out.
 */
function moveDir(src: string, dest: string, moved: string[]): void {
  if (!existsSync(src) || !statSync(src).isDirectory()) return;
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(src, dest);
      moved.push(`${src} -> ${dest}`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      mkdirSync(dest, { recursive: true }); // fall through to per-entry merge
    }
  }
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) moveDir(s, d, moved);
    else moveFile(s, d, moved);
  }
  try {
    rmdirSync(src); // only succeeds when everything moved out
  } catch {
    /* leftovers stay put; read-fallback + next boot handle them */
  }
}

/**
 * Run the migration if it has not completed yet. Cheap no-op (one existsSync)
 * on every boot after the first successful run.
 */
export function migrateFuryHome(): MigrationResult {
  const result: MigrationResult = { ran: false, moved: [], failed: [] };
  if (existsSync(markerPath())) return result;

  const home = furyHome();
  mkdirSync(home, { recursive: true });

  // Concurrency lock: atomic mkdir. If another instance holds a fresh lock,
  // skip this boot — the resolvers' read-fallback keeps data reachable.
  const lock = join(home, '.migrating');
  try {
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) {
        console.warn('[fury-home] migration lock held by another instance; skipping');
        return result;
      }
      // Stale lock from a crashed migrator — take it over.
    } catch {
      /* lock vanished between mkdir and stat — proceed */
    }
  }

  result.ran = true;
  console.log(`[fury-home] migrating Fury data into ${home} ...`);

  type Item = { label: string; skip?: boolean; run: () => void };
  const items: Item[] = [
    {
      // DB first — before anything can open a connection. Include SQLite
      // sidecars so a WAL-mode DB that wasn't cleanly checkpointed stays whole.
      label: 'fury.db',
      skip: !!process.env.FURY_DB_PATH,
      run: () => {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          moveFile(
            legacyPaths.dbFile() + suffix,
            furyPath('fury.db') + suffix,
            result.moved,
          );
        }
      },
    },
    {
      label: 'images',
      skip: !!process.env.FURY_IMAGES_PATH,
      run: () => moveDir(legacyPaths.imagesRoot(), furyPath('images'), result.moved),
    },
    {
      label: 'logs',
      run: () => moveDir(legacyPaths.logsDir(), furyPath('logs'), result.moved),
    },
    {
      label: 'provider-fallback-log',
      run: () => moveFile(
        legacyPaths.providerFallbackLog(),
        furyPath('provider-fallback-log.jsonl'),
        result.moved,
      ),
    },
    {
      label: 'notes',
      run: () => moveDir(legacyPaths.notesDir(), furyPath('notes'), result.moved),
    },
    {
      // $cwd/.claude-ui-state: settings.json keeps its name; state.json is
      // renamed to ui-state.json; anything else (e.g. *.corrupt quarantines)
      // moves name-preserved. Only the CURRENT cwd's copy is migrated — other
      // historical cwd copies (Fury launched from elsewhere) are unknowable
      // from here and deliberately left alone rather than guessed at.
      label: 'ui-state',
      run: () => {
        const src = legacyPaths.uiStateDir();
        if (!existsSync(src)) return;
        moveFile(join(src, 'state.json'), furyPath('state', 'ui-state.json'), result.moved);
        moveDir(src, furyPath('state'), result.moved);
      },
    },
    {
      label: 'prompts',
      run: () => moveDir(legacyPaths.promptsDir(), furyPath('state', 'prompts'), result.moved),
    },
    {
      label: 'workflows',
      run: () => moveDir(legacyPaths.workflowsDir(), furyPath('state', 'workflows'), result.moved),
    },
  ];

  for (const item of items) {
    if (item.skip) continue; // user pinned this store elsewhere via env
    try {
      item.run();
    } catch (err) {
      result.failed.push(item.label);
      console.error(`[fury-home] failed to migrate ${item.label}:`, err);
    }
  }

  // Marker only on a fully clean run; otherwise the next boot retries the
  // failed items (every move is individually idempotent).
  if (result.failed.length === 0) {
    writeFileSync(
      markerPath(),
      JSON.stringify({ version: MIGRATION_VERSION, migratedAt: new Date().toISOString() }) + '\n',
    );
  }
  rmSync(lock, { recursive: true, force: true });

  console.log(
    `[fury-home] migration ${result.failed.length ? 'PARTIAL' : 'complete'}: ` +
    `${result.moved.length} item(s) moved` +
    (result.failed.length ? `, failed: ${result.failed.join(', ')} (will retry next boot)` : ''),
  );
  return result;
}
