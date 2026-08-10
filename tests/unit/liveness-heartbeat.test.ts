/**
 * The liveness heartbeat (docs/design-liveness-single-source-of-truth.md §2, step 2).
 *
 * While a session is NON-IDLE the heartbeat re-emits the current liveness LEVEL every
 * beat, so a dropped edge or a wrong client teardown self-corrects within one beat
 * instead of persisting for the rest of the turn (review Finding 1's amplifier: a
 * single continuous turn emits `processing` only once). Idle sessions stay quiet.
 *
 * The timer itself is off under vitest (IN_TEST); these drive the private `heartbeatTick`
 * directly and assert what it emits, mirroring background-task-liveness.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent, type SessionHealthEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  const s = mgr.getOrCreate(id);
  s.q = {}; // truthy — the heartbeat only beats for sessions with a live query
  return s;
}

function captureHealth() {
  const events: SessionHealthEvent[] = [];
  const listener = (e: AppEvent) => { if (e.type === 'session:health') events.push(e); };
  eventBus.onApp(listener);
  return { events, stop: () => eventBus.offApp(listener) };
}

const bg = (tasks: Array<{ id: string; type: string }>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: tasks.map((t) => ({ task_id: t.id, task_type: t.type, description: 'x' })),
});

afterEach(() => {
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

describe('liveness heartbeat — re-emits the level while non-idle', () => {
  it('beats for a PROCESSING session (re-asserts the main-turn level)', () => {
    const s = newSession('hb-proc');
    s.isProcessing = true;
    const cap = captureHealth();
    mgr.heartbeatTick();
    cap.stop();
    const ev = cap.events.find((e) => e.sessionId === 'hb-proc');
    expect(ev, 'a heartbeat health event was emitted').toBeTruthy();
    expect(ev!.isProcessing).toBe(true);
    expect(ev!.liveness?.phase).toBe('main-turn');
  });

  it('beats for a BACKGROUND-agentic session (main idle, subagent running)', () => {
    const s = newSession('hb-bg');
    mgr.handle(s, bg([{ id: 'sub1', type: 'subagent' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now();
    const cap = captureHealth();
    mgr.heartbeatTick();
    cap.stop();
    const ev = cap.events.find((e) => e.sessionId === 'hb-bg');
    expect(ev, 'a heartbeat health event was emitted for background work').toBeTruthy();
    expect(ev!.isProcessing).toBe(false);
    expect(ev!.liveness?.phase).toBe('background');
  });

  it('stays QUIET for an idle session (no beat, no traffic)', () => {
    newSession('hb-idle'); // live query but not processing, no background work
    const cap = captureHealth();
    mgr.heartbeatTick();
    cap.stop();
    expect(cap.events.some((e) => e.sessionId === 'hb-idle')).toBe(false);
  });

  it('stays QUIET for a session whose query is gone (nothing to keep alive)', () => {
    const s = newSession('hb-dead');
    s.isProcessing = true; // would beat…
    s.q = null;            // …but the query ended, so it must not
    const cap = captureHealth();
    mgr.heartbeatTick();
    cap.stop();
    expect(cap.events.some((e) => e.sessionId === 'hb-dead')).toBe(false);
  });

  it('a shell-only background set does NOT beat (Defect A: detached shells are not work)', () => {
    const s = newSession('hb-shell');
    mgr.handle(s, bg([{ id: 'sh1', type: 'shell' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now();
    const cap = captureHealth();
    mgr.heartbeatTick();
    cap.stop();
    expect(cap.events.some((e) => e.sessionId === 'hb-shell')).toBe(false);
  });

  it('each beat advances the level seq (a fresh level, so the client can order them)', () => {
    const s = newSession('hb-seq');
    s.isProcessing = true;
    const cap = captureHealth();
    mgr.heartbeatTick();
    mgr.heartbeatTick();
    mgr.heartbeatTick();
    cap.stop();
    const seqs = cap.events.filter((e) => e.sessionId === 'hb-seq').map((e) => e.liveness?.seq);
    expect(seqs.length).toBe(3);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]!).toBeGreaterThan(seqs[1]!);
  });
});
