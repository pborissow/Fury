/**
 * Ownership discipline for the live-CLI handoff
 * (docs/ticket-resume-live-cli-session-hard-kill.md).
 *
 * The regression: startQuery SIGKILLed any process whose ~/.claude/sessions PID
 * file named the session id — including an EXTERNAL interactive terminal — because
 * PID files can't distinguish Fury's own resume subprocess from a user's terminal
 * (both write kind:'interactive', entrypoint:'sdk-ts'). These tests pin the fix:
 * detection is scoped to "a live pid we did NOT spawn", and reclaim is scoped to
 * pids Fury provably spawned (s.spawnedPids).
 *
 * Uses REAL child processes + REAL PID files under ~/.claude/sessions, since the
 * whole point is that the on-disk shape is ambiguous and only the tracked-pid set
 * disambiguates. Everything is cleaned up in afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { sdkSessionManager, isProvableOrphan } from '../../lib/sdkSessionManager';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const spawnedPids: number[] = [];
const pidFiles: string[] = [];
const sessionIds: string[] = [];

/** A real, harmless DIRECT child of this test process — its parent IS process.pid,
 *  so it stands in for a Fury-spawned CLI (ancestry attributes it to us). */
function spawnDummy(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  spawnedPids.push(pid);
  return pid;
}

/**
 * A GRANDCHILD whose parent (an intermediate node process) stays alive but is NOT
 * this test process — so parentPidOf(grandchild) !== process.pid. This is the
 * external-terminal stand-in: without it, a direct child would be misread as
 * Fury-owned by the ancestry fallback (its ppid would be process.pid).
 */
function spawnExternalDummy(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const parent = spawn(
      process.execPath,
      ['-e',
        "const cp=require('child_process');" +
        "const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},100000)'],{stdio:'ignore'});" +
        'process.stdout.write(String(c.pid));' +
        'setInterval(()=>{},100000);',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    spawnedPids.push(parent.pid!);
    let out = '';
    parent.stdout!.on('data', (d) => { out += d.toString(); });
    const started = Date.now();
    const poll = setInterval(() => {
      const gp = parseInt(out.trim(), 10);
      if (Number.isFinite(gp) && gp > 0) {
        clearInterval(poll);
        spawnedPids.push(gp);
        resolve(gp);
      } else if (Date.now() - started > 4000) {
        clearInterval(poll);
        reject(new Error('grandchild pid never arrived'));
      }
    }, 25);
    parent.on('error', reject);
  });
}

function writePidFile(pid: number, sessionId: string, name = 'ext-term'): string {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const full = join(SESSIONS_DIR, `${pid}.json`);
  writeFileSync(full, JSON.stringify({ pid, sessionId, kind: 'interactive', entrypoint: 'sdk-ts', name }));
  pidFiles.push(full);
  return full;
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* dead */ } }
  for (const f of pidFiles.splice(0)) { try { rmSync(f); } catch { /* gone */ } }
  // Drop any sessions the tests minted so the singleton doesn't accrue state.
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of sessionIds.splice(0)) sessions.delete(id);
});

describe('detectExternalOwner', () => {
  it('flags a live process that owns the session and that Fury did not spawn', async () => {
    const sessionId = randomUUID();
    const pid = await spawnExternalDummy(); // parent is NOT this server → external
    writePidFile(pid, sessionId, 'someones-terminal');

    const owner = await sdkSessionManager.detectExternalOwner(sessionId);
    expect(owner?.pid).toBe(pid);
    expect(owner?.name).toBe('someones-terminal');
  });

  it('does NOT flag a pid Fury itself spawned (own subprocess is not an external owner)', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const pid = spawnDummy();
    writePidFile(pid, sessionId);

    // Mirror what the custom spawnClaudeCodeProcess records at spawn time (the
    // PRIMARY ownership signal — a recorded spawn pid).
    const s = (sdkSessionManager as unknown as { getOrCreate: (id: string) => { spawnedPids: Set<number> } })
      .getOrCreate(sessionId);
    s.spawnedPids.add(pid);

    expect(await sdkSessionManager.detectExternalOwner(sessionId)).toBeNull();
  });

  it('does NOT flag a live child of THIS server even with no spawn record (ancestry fallback)', async () => {
    const sessionId = randomUUID();
    // A real child of this test process — its ppid IS process.pid, so the ancestry
    // fallback must attribute it to us even though it is NOT in spawnedPids.
    const pid = spawnDummy();
    writePidFile(pid, sessionId, 'unrecorded-fury-child');

    expect(await sdkSessionManager.detectExternalOwner(sessionId)).toBeNull();
  });

  it('sweeps a stale PID file for a dead process and reports no owner', async () => {
    const sessionId = randomUUID();
    const pid = spawnDummy();
    const file = writePidFile(pid, sessionId);
    process.kill(pid, 'SIGKILL');
    await waitUntilDead(pid);

    expect(await sdkSessionManager.detectExternalOwner(sessionId)).toBeNull();
    expect(existsSync(file), 'dead-pid PID file is swept (Issue B)').toBe(false);
  });
});

describe('isProvableOrphan (reap only what we can prove is a leftover)', () => {
  const SELF = 4242;
  const allAlive = () => true;
  const allDead = () => false;

  it('does NOT reap when the ancestry lookup failed (null → spare, never kill)', () => {
    // Regression guard: a transient parentPidOf failure at boot must not fall
    // through to SIGKILL — that could take out a user's terminal.
    expect(isProvableOrphan(null, SELF, allAlive)).toBe(false);
    expect(isProvableOrphan(null, SELF, allDead)).toBe(false);
  });

  it('does NOT reap a child of this server (current-life, not a leftover)', () => {
    expect(isProvableOrphan(SELF, SELF, allDead)).toBe(false);
  });

  it('does NOT reap a process attached to a live, non-init parent (external terminal)', () => {
    expect(isProvableOrphan(9999, SELF, allAlive)).toBe(false);
  });

  it('reaps a Linux orphan (re-parented to init, pid 1)', () => {
    expect(isProvableOrphan(1, SELF, allAlive)).toBe(true);
  });

  it('reaps a Windows orphan (stale ParentProcessId → parent dead)', () => {
    expect(isProvableOrphan(9999, SELF, allDead)).toBe(true);
  });
});

describe('reclaimOwnLeaks (criterion 2: Fury still reclaims its OWN leaks)', () => {
  it('SIGKILLs a still-alive pid Fury spawned and clears its tracking + PID file', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const pid = spawnDummy();
    const file = writePidFile(pid, sessionId);

    const s = (sdkSessionManager as unknown as {
      getOrCreate: (id: string) => { spawnedPids: Set<number> };
      reclaimOwnLeaks: (s: unknown) => void;
    });
    const session = s.getOrCreate(sessionId);
    session.spawnedPids.add(pid); // a leak from a prior interrupted turn

    s.reclaimOwnLeaks(session);
    await waitUntilDead(pid);

    expect(isAlive(pid), 'the leaked Fury process is reclaimed').toBe(false);
    expect(session.spawnedPids.has(pid), 'pid dropped from tracking').toBe(false);
    expect(existsSync(file), 'leaked PID file removed').toBe(false);
  });
});
