/**
 * Background-task liveness (docs/ticket-live-badge-dark-during-background-subagent.md).
 *
 * An orchestrator's own main turn ends while a dispatched background subagent keeps
 * working; the session must stay live (badge + dots) across that wait. Drives the
 * private handle() with the SDK's `system/background_tasks_changed` LEVEL signal and
 * asserts the REPLACE semantics, the emitted health flag, and the teardown/gating
 * safety that prevents a stale set pinning a dead session "live".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { projectPathToSlug } from '../../lib/utils';
import { eventBus, type AppEvent, type SessionHealthEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  const s = mgr.getOrCreate(id);
  s.q = {}; // a truthy stub — getBackgroundActiveSessionIds gates on a live query
  return s;
}

function captureHealth() {
  const events: SessionHealthEvent[] = [];
  const listener = (e: AppEvent) => { if (e.type === 'session:health') events.push(e); };
  eventBus.onApp(listener);
  return { events, stop: () => eventBus.offApp(listener) };
}

const bgChanged = (taskIds: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: taskIds.map((id) => ({ task_id: id, task_type: 'Task', description: 'work' })),
});

const bgChangedTyped = (tasks: Array<{ id: string; type: string }>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: tasks.map((t) => ({ task_id: t.id, task_type: t.type, description: 'work' })),
});

afterEach(() => {
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

describe('background_tasks_changed → liveness', () => {
  it('tracks the set and emits health with backgroundActive true', () => {
    const s = newSession('bg-1');
    const cap = captureHealth();
    mgr.handle(s, bgChanged(['t1', 't2']));
    cap.stop();

    expect([...s.backgroundTasks].sort()).toEqual(['t1', 't2']);
    expect(mgr.isBackgroundActive('bg-1')).toBe(true);
    expect(mgr.getBackgroundActiveSessionIds()).toContain('bg-1');
    const ev = cap.events.find((e) => e.sessionId === 'bg-1');
    expect(ev?.backgroundActive).toBe(true);
  });

  it('REPLACES (not merges) the set on each payload — a level signal', () => {
    const s = newSession('bg-2');
    mgr.handle(s, bgChanged(['t1', 't2']));
    mgr.handle(s, bgChanged(['t3'])); // t1/t2 done, t3 started
    expect([...s.backgroundTasks]).toEqual(['t3']);
  });

  it('an empty payload clears liveness (last task completed)', () => {
    const s = newSession('bg-3');
    mgr.handle(s, bgChanged(['t1']));
    expect(mgr.isBackgroundActive('bg-3')).toBe(true);
    const cap = captureHealth();
    mgr.handle(s, bgChanged([]));
    cap.stop();

    expect(s.backgroundTasks.size).toBe(0);
    expect(mgr.isBackgroundActive('bg-3')).toBe(false);
    expect(mgr.getBackgroundActiveSessionIds()).not.toContain('bg-3');
    expect(cap.events.find((e) => e.sessionId === 'bg-3')?.backgroundActive).toBe(false);
  });

  it('self-heals a WEDGED set: idle main turn + stale + no activity clears it (lost clearing signal)', () => {
    const s = newSession('bg-wedge');
    mgr.handle(s, bgChanged(['t1'])); // set populated, lastBgActivityAt = now
    expect(mgr.isBackgroundActive('bg-wedge')).toBe(true);

    // The terminal `background_tasks_changed []` never arrives (dropped stream /
    // crash mid-task): the set stays non-empty, the main turn is idle, no further
    // signal comes. Without the heal this pins backgroundActive true forever and
    // strands the dots (the Camera2 report).
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 4 * 60_000; // older than WEDGED_BG_GRACE_MS (3 min)

    expect(mgr.isBackgroundActive('bg-wedge')).toBe(false); // healed
    expect(s.backgroundTasks.size).toBe(0); // wedged set dropped
  });

  it('does NOT over-clear while signals are still fresh (a genuinely live task stays live)', () => {
    const s = newSession('bg-fresh');
    mgr.handle(s, bgChanged(['t1']));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 10_000; // 10s ago — well within grace
    expect(mgr.isBackgroundActive('bg-fresh')).toBe(true);
    expect(s.backgroundTasks.size).toBe(1);
  });

  it('a task_* EDGE refreshes the liveness clock so an emitting task survives past the grace', () => {
    const s = newSession('bg-edge');
    mgr.handle(s, bgChanged(['t1']));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 4 * 60_000; // would be stale…
    mgr.handle(s, { type: 'system', subtype: 'task_progress', task_id: 't1' }); // …but progress arrives
    expect(mgr.isBackgroundActive('bg-edge')).toBe(true);
    expect(s.backgroundTasks.size).toBe(1);
  });

  it('does NOT count a session whose query/process is gone (stale set cannot pin a dead session)', () => {
    const s = newSession('bg-4');
    mgr.handle(s, bgChanged(['t1']));
    expect(mgr.getBackgroundActiveSessionIds()).toContain('bg-4');

    s.q = null; // the persistent query ended — background work can't still run
    expect(mgr.getBackgroundActiveSessionIds()).not.toContain('bg-4');
    expect(mgr.isBackgroundActive('bg-4')).toBe(false);
  });

  it('teardown (stop) clears the set', async () => {
    const s = newSession('bg-5');
    mgr.handle(s, bgChanged(['t1', 't2']));
    await mgr.stop('bg-5');
    expect(s.backgroundTasks.size).toBe(0);
    expect(mgr.isBackgroundActive('bg-5')).toBe(false);
  });

  it('ignores malformed task entries (missing task_id)', () => {
    const s = newSession('bg-6');
    mgr.handle(s, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_type: 'Task' }, { task_id: 'good' }, { task_id: 42 }],
    });
    expect([...s.backgroundTasks]).toEqual(['good']);
  });
});

/**
 * Wedge-grace ANCHORING (docs/ticket-live-badge-flicker-quiet-background-task.md).
 *
 * The grace must measure background silence from the START OF THE BACKGROUND PHASE
 * (main-turn idle), not from the dispatch edge. Anchored at dispatch, the clock ages
 * while the main turn is still processing, so a quiet task can be cleared as "wedged"
 * while it is genuinely alive — the Live badge flickers dark mid-work.
 *
 * Numbers below are the real ones from the logged incident (session 58bbacd1,
 * fury-2026-08-20.jsonl): dispatch 41.6s before the turn ended, then 78.5s of silence
 * — 120.1s since dispatch (past the 120s grace → cleared) but only 78.5s since idle.
 */
describe('wedge grace is anchored at the background phase, not at dispatch', () => {
  const result = () => ({ type: 'result', subtype: 'success', result: 'ok' });

  /** An inbound message on a subagent sidechain (streamed back to the parent). */
  const sidechain = () => ({ type: 'stream_event', parent_tool_use_id: 'toolu_sub', event: null });
  /** The same message shape on the MAIN thread — no parent_tool_use_id. */
  const mainThread = () => ({ type: 'stream_event', event: null });

  it('re-anchors the clock when the main turn goes idle (the reported flicker)', () => {
    const s = newSession('bg-anchor');
    mgr.handle(s, bgChanged(['t1']));

    // The task was dispatched 41.6s ago and has been silent since; the main turn is
    // still processing, so the badge is live via isProcessing.
    s.isProcessing = true;
    s.lastBgActivityAt = Date.now() - 41_600;

    mgr.handle(s, result()); // turn ends → the background phase begins HERE
    expect(s.isProcessing).toBe(false);
    expect(Date.now() - s.lastBgActivityAt).toBeLessThan(1_000); // clock re-anchored

    // 78.5s of total background silence. Measured from DISPATCH that is 120.1s and
    // the set would be cleared as wedged (the bug). Measured from idle-start it is
    // well inside the grace, so the badge stays lit for the whole background window.
    s.lastBgActivityAt = Date.now() - 78_500;
    expect(mgr.isBackgroundActive('bg-anchor')).toBe(true);
    expect(s.backgroundTasks.size).toBe(1);
  });

  it('still self-heals a wedged set — one full grace measured FROM idle-start', () => {
    const s = newSession('bg-anchor-heal');
    mgr.handle(s, bgChanged(['t1']));
    s.isProcessing = true;
    mgr.handle(s, result()); // anchor at idle-start

    // The terminal clearing signal is genuinely lost and nothing ever emits again.
    // The heal must still fire — just measured from the background phase, not forever.
    s.lastBgActivityAt = Date.now() - 121_000;
    expect(mgr.isBackgroundActive('bg-anchor-heal')).toBe(false);
    expect(s.backgroundTasks.size).toBe(0);
  });

  it('a sidechain message from a running subagent refreshes the clock (proof-of-life)', () => {
    const s = newSession('bg-sidechain');
    mgr.handle(s, bgChanged(['t1']));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 4 * 60_000; // would be stale…

    mgr.handle(s, sidechain()); // …but the subagent is visibly still streaming
    expect(mgr.isBackgroundActive('bg-sidechain')).toBe(true);
    expect(s.backgroundTasks.size).toBe(1);
  });

  it('a MAIN-THREAD message does NOT refresh the clock (scoping keeps the heal working)', () => {
    const s = newSession('bg-mainthread');
    mgr.handle(s, bgChanged(['t1']));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 4 * 60_000;

    // Idle-process noise on the main thread is not evidence the background set is
    // alive. If this refreshed the clock, a genuinely dead set would never self-heal.
    mgr.handle(s, mainThread());
    expect(mgr.isBackgroundActive('bg-mainthread')).toBe(false);
    expect(s.backgroundTasks.size).toBe(0); // healed
  });

  it('does not touch the clock at all when no background task exists (criterion 3)', () => {
    const s = newSession('bg-noise');
    s.isProcessing = false;
    expect(s.backgroundTasks.size).toBe(0);
    expect(s.lastBgActivityAt).toBeUndefined();

    mgr.handle(s, sidechain());
    expect(s.lastBgActivityAt).toBeUndefined(); // never stamped for an empty set
  });
});

/**
 * TASK KIND IS NOT LOAD-BEARING (2026-08-21 decision, docs/ticket-live-badge-
 * flicker-quiet-background-task.md).
 *
 * This block previously asserted Defect A (docs/ticket-dots-desync-subagent-heavy-
 * session.md): that a detached `run_in_background` Bash must go dark the moment the
 * main turn goes idle, while only agentic tasks earned the wedge grace. That policy
 * is REVERSED — a backgrounded build / dev server / test run is work the user wants
 * to see as live — and the `backgroundHasAgentic` gate it relied on is deleted.
 *
 * Why the gate went rather than just flipping its default: it keyed on a 'shell' /
 * 'bash' `task_type`, but the real CLI emits `local_bash`, so it never fired in
 * production anyway (that misclassification is what produced the 2026-08-20
 * incident). Left in place, a CLI rename to anything containing 'shell' would have
 * silently resurrected the dark-badge behaviour.
 *
 * These tests now pin the single rule — a non-empty set is live until the grace
 * expires, whatever the task kind — using the REAL wire value alongside the
 * synthetic ones, so no task_type can quietly regain control of liveness.
 */
describe('background liveness does not branch on task_type', () => {
  const KINDS = ['local_bash', 'shell', 'bash', 'subagent', 'monitor', 'workflow', undefined];

  for (const type of KINDS) {
    it(`treats task_type=${JSON.stringify(type)} as live while the main turn processes`, () => {
      const s = newSession(`bg-proc-${String(type)}`);
      mgr.handle(s, bgChangedTyped([{ id: 'x1', type: type as string }]));
      s.isProcessing = true;
      expect(mgr.isBackgroundActive(`bg-proc-${String(type)}`)).toBe(true);
    });

    it(`sustains task_type=${JSON.stringify(type)} through the grace once idle`, () => {
      const s = newSession(`bg-idle-${String(type)}`);
      mgr.handle(s, bgChangedTyped([{ id: 'x1', type: type as string }]));
      s.isProcessing = false;
      s.lastBgActivityAt = Date.now() - 10_000; // within grace
      expect(mgr.isBackgroundActive(`bg-idle-${String(type)}`)).toBe(true);
      expect(s.backgroundTasks.size).toBe(1);
    });

    it(`self-heals a wedged task_type=${JSON.stringify(type)} set`, () => {
      const s = newSession(`bg-wedged-${String(type)}`);
      mgr.handle(s, bgChangedTyped([{ id: 'x1', type: type as string }]));
      s.isProcessing = false;
      s.lastBgActivityAt = Date.now() - 4 * 60_000; // past WEDGED_BG_GRACE_MS
      expect(mgr.isBackgroundActive(`bg-wedged-${String(type)}`)).toBe(false);
      expect(s.backgroundTasks.size).toBe(0);
    });
  }

  it('a detached shell outliving its turn stays live for the grace (Defect A reversed)', () => {
    // The exact 2026-08-20 shape: a `run_in_background` docker build dispatched
    // mid-turn, arriving as `local_bash`, still running when the turn ends.
    const s = newSession('bg-local-bash');
    mgr.handle(s, bgChangedTyped([{ id: 'b1t7e3w4i', type: 'local_bash' }]));
    s.isProcessing = true;
    mgr.handle(s, { type: 'result', subtype: 'success', result: 'ok' });

    // Pre-decision this was dark the instant the turn ended (Defect A); it is now
    // lit for the whole grace window measured from idle-start.
    expect(mgr.isBackgroundActive('bg-local-bash')).toBe(true);
    s.lastBgActivityAt = Date.now() - 119_000;
    expect(mgr.isBackgroundActive('bg-local-bash')).toBe(true);
  });

  it('a MIXED set behaves the same as either kind alone', () => {
    const s = newSession('bg-mixed');
    mgr.handle(s, bgChangedTyped([{ id: 'sub1', type: 'subagent' }, { id: 'sh1', type: 'local_bash' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 10_000;
    expect(mgr.isBackgroundActive('bg-mixed')).toBe(true);
    expect(s.backgroundTasks.size).toBe(2);
  });
});

describe('getFuryWarmSessionIds (stale-LIVE-while-idle safety net)', () => {
  const spawnedProcs = () => (sdkSessionManager as unknown as { spawnedProcs: Map<number, string> }).spawnedProcs;
  afterEach(() => spawnedProcs().clear());

  it('reports a warm session even after its record is dropped from the map (the desync)', () => {
    const sessionId = randomUUID();
    // Simulate spawnClaudeCodeProcess recording a live warm pid (process.pid is a
    // guaranteed-alive stand-in), then the session record being evicted.
    spawnedProcs().set(process.pid, sessionId);
    (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId);

    // Precondition for the bug: the managed-subtract can no longer see it…
    expect(sdkSessionManager.getManagedSessionIds()).not.toContain(sessionId);
    // …but the durable warm record still does, so the badge can suppress it.
    expect(sdkSessionManager.getFuryWarmSessionIds()).toContain(sessionId);
  });

  it('drops a warm session once its process is dead (prunes the stale pid)', () => {
    const sessionId = randomUUID();
    // A pid that is not alive (0 never matches a real process for signal checks here;
    // use a very high pid unlikely to exist).
    const deadPid = 2 ** 30;
    spawnedProcs().set(deadPid, sessionId);
    expect(sdkSessionManager.getFuryWarmSessionIds()).not.toContain(sessionId);
    expect(spawnedProcs().has(deadPid), 'dead pid opportunistically pruned').toBe(false);
  });
});

describe('background liveness reconcile across a code reload (durable subagent scan)', () => {
  const projectsBase = join(homedir(), '.claude', 'projects');
  const ids: string[] = [];
  const slugDirs: string[] = [];

  // Build the real on-disk shape the reconcile scans: a main transcript (so
  // findSessionJsonlDir resolves) + a subagent transcript with a chosen mtime.
  function seed(opts: { subagent?: 'recent' | 'stale' }): { sessionId: string; s: any } {
    const sessionId = randomUUID();
    ids.push(sessionId);
    const project = join(homedir(), '.claude', `fury-reconcile-tmp-${sessionId}`);
    const slugDir = join(projectsBase, projectPathToSlug(project));
    slugDirs.push(slugDir);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, `${sessionId}.jsonl`), '{}\n');
    if (opts.subagent) {
      const subDir = join(slugDir, sessionId, 'subagents');
      mkdirSync(subDir, { recursive: true });
      const f = join(subDir, 'agent-aaa111bbb222.jsonl');
      writeFileSync(f, '{}\n');
      if (opts.subagent === 'stale') {
        const old = (Date.now() - 5 * 60_000) / 1000; // 5 min ago — past the window
        utimesSync(f, old, old);
      }
    }
    const s = (sdkSessionManager as any).getOrCreate(sessionId);
    s.projectPath = project;
    s.q = {};
    return { sessionId, s };
  }

  afterEach(() => {
    const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
    for (const id of ids.splice(0)) sessions.delete(id);
    for (const d of slugDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  it('reload fallback: a recently-written subagent transcript re-seeds backgroundActive', () => {
    const { sessionId } = seed({ subagent: 'recent' });
    expect(sdkSessionManager.isBackgroundActive(sessionId)).toBe(true);
    expect(sdkSessionManager.getBackgroundActiveSessionIds()).toContain(sessionId);
  });

  it('the live level takes over: after a level signal, the disk fallback is OFF', () => {
    const { sessionId, s } = seed({ subagent: 'recent' });
    s.sawBackgroundLevelSignal = true; // the CLI emitted its level this process
    expect(sdkSessionManager.isBackgroundActive(sessionId)).toBe(false);
  });

  it('fails toward not-live once the subagent transcript goes stale', () => {
    const { sessionId } = seed({ subagent: 'stale' });
    expect(sdkSessionManager.isBackgroundActive(sessionId)).toBe(false);
  });

  it('no subagents dir at all → not active', () => {
    const { sessionId } = seed({});
    expect(sdkSessionManager.isBackgroundActive(sessionId)).toBe(false);
  });

  it('reconcile tick emits session:health {backgroundActive:true} on the false→true transition', () => {
    const { sessionId } = seed({ subagent: 'recent' });
    const events: SessionHealthEvent[] = [];
    const listener = (e: AppEvent) => { if (e.type === 'session:health' && e.sessionId === sessionId) events.push(e); };
    eventBus.onApp(listener);
    (sdkSessionManager as any).reconcileBackgroundActivity();
    eventBus.offApp(listener);
    expect(events.at(-1)?.backgroundActive).toBe(true);
    expect(events.at(-1)?.isProcessing).toBe(false);
  });
});
