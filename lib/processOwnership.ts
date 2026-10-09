/**
 * Process-ownership primitives shared by the SDK session manager and the
 * stealth-session registry: "is this pid alive", "who is its parent", and the
 * conservative "is this a PROVABLE orphan (safe to SIGKILL)" decision.
 * Extracted verbatim from lib/sdkSessionManager.ts; see
 * docs/ticket-resume-live-cli-session-hard-kill.md for the reasoning.
 */
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/** Liveness probe: signal 0 throws iff the pid is gone (or not ours to signal). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Given a candidate process's parent pid, is it a PROVABLE orphaned leftover —
 * i.e. safe for reapOrphanedProcesses to SIGKILL?
 *
 * ONLY two states prove orphan-hood: the parent is init (Linux re-parents orphans
 * to pid 1) or the parent is dead (Windows leaves a stale ParentProcessId once the
 * spawning server exits). EVERYTHING ELSE is spared:
 *   - `ppid === null` — the OS lookup failed. parentPidOf's contract is explicit:
 *     never kill on a failed lookup. Falling through to SIGKILL here is exactly
 *     how a transient PowerShell failure at boot could take out a user's terminal.
 *   - a live, non-init parent — the process is attached to a real shell/terminal
 *     the user is in (an external session), not our leftover.
 *   - `ppid === selfPid` — a child of THIS server (current life, not a leftover).
 *
 * Pure and injectable (`alive`) so the reap decision is unit-testable without the
 * unscoped sweep, which can't run in a test (it would target real machine sessions).
 */
export function isProvableOrphan(
  ppid: number | null,
  selfPid: number,
  alive: (pid: number) => boolean,
): boolean {
  if (ppid === null || ppid === selfPid) return false;
  return ppid === 1 || !alive(ppid);
}

/**
 * The parent pid of an arbitrary process, or null if it can't be determined.
 *
 * Node exposes process.ppid for ITSELF only, so ownership attribution
 * (docs/ticket-resume-live-cli-session-hard-kill.md) has to go to the OS. This is
 * the ancestry signal the ticket's process-model findings settled on: a
 * Fury-spawned CLI is a direct child of this server process, so
 * `parentPidOf(pid) === process.pid` proves ownership when no spawn record exists
 * (e.g. a PID file we never got to record). PID files' kind/entrypoint/startedAt
 * are all proven NON-discriminating — an external terminal is byte-for-byte the
 * same shape — so this is the only field-independent test.
 *
 * Best-effort and defensive: any failure returns null, and callers MUST treat
 * null as "cannot prove ownership" → leave the process alive (never kill on a
 * failed lookup). One short-lived OS query per uncached candidate; the hot path
 * (pid already in spawnedPids) never reaches here.
 */
export async function parentPidOf(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      // Win32_Process.ParentProcessId — exactly what diagnosed this ticket.
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ]);
      const ppid = parseInt(stdout.trim(), 10);
      return Number.isFinite(ppid) ? ppid : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('ps', ['-o', 'ppid=', '-p', String(pid)]);
      const ppid = parseInt(stdout.trim(), 10);
      return Number.isFinite(ppid) ? ppid : null;
    }
    // Linux: field 4 of /proc/<pid>/stat, but comm (field 2) can contain spaces
    // and parens, so index from the LAST ')' rather than splitting from the start.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = parseInt(rest[1], 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}
