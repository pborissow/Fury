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
 * Defect A (docs/ticket-dots-desync-subagent-heavy-session.md): a detached
 * `run_in_background` Bash task (`task_type: 'shell'`/'bash') is NOT Claude work,
 * so once the main turn is idle it must not keep the dots lit via the 120s wedge
 * grace — the phantom-dots-over-a-finished-bubble symptom. A genuine background
 * subagent/monitor/workflow keeps its intended v24 cross-turn liveness.
 */
describe('background_tasks_changed → detached shells vs Claude subagents (Defect A)', () => {
  it('a detached-shell-only set keeps dots lit WHILE the main turn processes', () => {
    const s = newSession('bg-shell-proc');
    mgr.handle(s, bgChangedTyped([{ id: 'sh1', type: 'shell' }]));
    expect(s.backgroundHasAgentic).toBe(false);
    s.isProcessing = true;
    expect(mgr.isBackgroundActive('bg-shell-proc')).toBe(true); // main turn covers it
  });

  it('a detached-shell-only set does NOT sustain dots once the main turn is idle (no phantom dots)', () => {
    const s = newSession('bg-shell-idle');
    mgr.handle(s, bgChangedTyped([{ id: 'sh1', type: 'shell' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now(); // FRESH — well within the grace
    // Pre-fix this returned true for the full grace (phantom dots over a finished
    // bubble). A detached run_in_background shell is not "Claude is working".
    expect(mgr.isBackgroundActive('bg-shell-idle')).toBe(false);
    // The set is left INTACT (the shell is still live; a later level signal — its
    // exit — REPLACES the set cleanly). Clearing here would only churn.
    expect(s.backgroundTasks.size).toBe(1);
  });

  it('classifies a bash task as a detached shell too', () => {
    const s = newSession('bg-bash');
    mgr.handle(s, bgChangedTyped([{ id: 'b1', type: 'bash' }]));
    expect(s.backgroundHasAgentic).toBe(false);
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now();
    expect(mgr.isBackgroundActive('bg-bash')).toBe(false);
  });

  it('a MIXED set (subagent + shell) still sustains via the grace while idle', () => {
    const s = newSession('bg-mixed');
    mgr.handle(s, bgChangedTyped([{ id: 'sub1', type: 'subagent' }, { id: 'sh1', type: 'shell' }]));
    expect(s.backgroundHasAgentic).toBe(true);
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 10_000; // within grace
    expect(mgr.isBackgroundActive('bg-mixed')).toBe(true);
    expect(s.backgroundTasks.size).toBe(2);
  });

  it('unknown/agentic task types (e.g. monitor) fail toward showing liveness via the grace', () => {
    const s = newSession('bg-monitor');
    mgr.handle(s, bgChangedTyped([{ id: 'm1', type: 'monitor' }]));
    expect(s.backgroundHasAgentic).toBe(true);
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 10_000;
    expect(mgr.isBackgroundActive('bg-monitor')).toBe(true);
  });

  it('a genuine agentic set STILL self-heals when wedged (idle + stale + no activity)', () => {
    const s = newSession('bg-agentic-wedge');
    mgr.handle(s, bgChangedTyped([{ id: 'sub1', type: 'subagent' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now() - 4 * 60_000; // past WEDGED_BG_GRACE_MS
    expect(mgr.isBackgroundActive('bg-agentic-wedge')).toBe(false);
    expect(s.backgroundTasks.size).toBe(0); // wedged agentic set dropped
    expect(s.backgroundHasAgentic).toBe(false);
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
