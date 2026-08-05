import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Normalize an incoming `args` value to an argv array.
 *
 * The code-search wizard sends a real array (`['--db', '<path>', 'mcp']`) so a
 * DB/home path containing a space survives as ONE argv entry. The free-form
 * stdio field still sends a whitespace-joined string, where spaces are the
 * user's own separators — split that. Never split an array (that's what breaks
 * spaced paths — B3 in docs/ticket-local-mcp-this-project-fails-first-use.md).
 */
export function normalizeArgs(args: unknown): string[] {
  if (Array.isArray(args)) return args.map(a => String(a)).filter(Boolean);
  if (typeof args === 'string') return args.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * Given an argv array, return the value of a `--db <path>` pair, or null.
 */
export function dbPathFromArgs(argv: string[]): string | null {
  const i = argv.indexOf('--db');
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1] || null;
}

/**
 * If a stdio server is launched with `--db <path>` (the codemogger code-search
 * flow), create the DB's parent directory. codemogger only auto-creates the
 * parent for its DEFAULT path; given an explicit `--db` it crashes on first
 * launch with "I/O error (open): entity not found" when `~/.codemogger` doesn't
 * exist. A fresh empty dir is enough — codemogger creates index.db itself.
 * (B1 in docs/ticket-local-mcp-this-project-fails-first-use.md.)
 *
 * Returns the directory it ensured, or null if there was no `--db` arg.
 */
export async function ensureDbParentDir(argv: string[]): Promise<string | null> {
  const dbPath = dbPathFromArgs(argv);
  if (!dbPath) return null;
  const dir = dirname(dbPath);
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    console.error('[mcpArgs] Failed to create --db parent dir for', dbPath, err);
    return null;
  }
}

/**
 * If `projectPath` is a git repo, ensure `entry` (e.g. `.codemogger/`) is in its
 * `.gitignore` so the per-project index DB isn't accidentally committed.
 *
 * "Is a git repo" = `<projectPath>/.git` exists as a dir OR a file — worktrees and
 * submodules use a `.git` FILE, not a dir. **Never creates `.gitignore` in a
 * non-git project** — we don't assume a user who hasn't `git init`-ed wants git.
 * Idempotent (skips if already ignored) and best-effort (never throws).
 *
 * Returns true if the entry is present in .gitignore afterward (added or already
 * there), false if skipped (not a repo) or on write failure.
 */
export async function ensureGitignoredIfRepo(projectPath: string, entry: string): Promise<boolean> {
  if (!existsSync(join(projectPath, '.git'))) return false; // not git-initialized
  const giPath = join(projectPath, '.gitignore');
  let current = '';
  try { current = await readFile(giPath, 'utf-8'); } catch { /* missing — safe to create IN a git repo */ }
  const normalized = entry.replace(/\/+$/, '');
  const already = current.split(/\r?\n/).some(l => {
    const t = l.trim();
    return t === entry || t === normalized || t === `${normalized}/`;
  });
  if (already) return true;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  try {
    await writeFile(giPath, `${current}${prefix}\n# Codemogger index (Fury code search)\n${entry}\n`);
    return true;
  } catch (err) {
    console.error('[mcpArgs] Failed to update .gitignore for', projectPath, err);
    return false;
  }
}
