/**
 * Shared harness for the live-session "drive" specs — the costly E2Es that POST a
 * real turn to the SDK backend and assert against the on-disk JSONL / fury-logs
 * (inflight-partials-health, freshness-leaf, background-task-reassert).
 *
 * These all need the same scaffolding: a scratch project dir, PID-file reaping,
 * fury-log reading, and a full teardown that deletes the session and prunes its
 * disk traces. Kept here (a non-`.spec.ts` module, so Playwright's default
 * testMatch never collects it as a test — same convention as find-session.ts) so
 * the drives stay consistent instead of triplicating the boilerplate.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findSessionJsonlDir } from '../../lib/sessionPaths';
import { furyLogsDir } from '../../lib/furyHome';

export const BASE_URL = 'http://localhost:3879';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The on-disk JSONL path for a session under a project cwd, or null if not created yet. */
export function jsonlPath(sessionId: string, project: string): string | null {
  const loc = findSessionJsonlDir(sessionId, project);
  return loc ? join(loc.dir, `${sessionId}.jsonl`) : null;
}

/** SIGKILL + unlink every ~/.claude/sessions PID file whose entry matches `match`. */
export function reapPidFiles(match: (entry: any) => boolean): void {
  const dir = join(homedir(), '.claude', 'sessions');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = join(dir, f);
    try {
      const e = JSON.parse(readFileSync(full, 'utf8'));
      if (match(e) && typeof e.pid === 'number') {
        try { process.kill(e.pid, 'SIGKILL'); } catch { /* dead */ }
        try { rmSync(full); } catch { /* leave stale */ }
      }
    } catch { /* unreadable/foreign pid file — skip */ }
  }
}

/** All fury-log entries for a session, across daily files, in file order. */
export function furyLogLinesFor(sessionId: string): any[] {
  const dir = furyLogsDir();
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.sessionId === sessionId) out.push(e); } catch { /* partial */ }
    }
  }
  return out;
}

/** Wipe + recreate a scratch project dir, retrying the unlink (Windows can hold a lock). */
export async function resetProjectDir(project: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try { rmSync(project, { recursive: true, force: true }); break; } catch { await sleep(500); }
  }
  mkdirSync(project, { recursive: true });
}

/** POST a turn to the SDK backend. Returns the raw fetch Response. */
export function driveTurn(sessionId: string, project: string, prompt: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/claude-sdk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, sessionId, projectPath: project }),
  });
}

/**
 * Full teardown for a driven session: delete via the API (kills the CLI, forgets
 * the session), then a disk fallback for the JSONL, any leftover PID file, and the
 * history.jsonl entries. Safe to call in afterAll with a possibly-null id.
 */
export async function cleanupSession(sessionId: string | null, project: string): Promise<void> {
  if (!sessionId) return;
  try {
    await fetch(
      `${BASE_URL}/api/session?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
      { method: 'DELETE' },
    );
  } catch { /* server down — disk fallback below */ }
  try { const p = jsonlPath(sessionId, project); if (p) rmSync(p); } catch { /* best effort */ }
  reapPidFiles((e) => e.sessionId === sessionId);
  try {
    const hist = join(homedir(), '.claude', 'history.jsonl');
    if (existsSync(hist)) {
      const kept = readFileSync(hist, 'utf8').split('\n').filter((l) => !l.includes(sessionId));
      writeFileSync(hist, kept.join('\n'));
    }
  } catch { /* best effort */ }
}
