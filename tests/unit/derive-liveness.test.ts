/**
 * The single-source-of-truth liveness projection
 * (docs/design-liveness-single-source-of-truth.md, migration step 1).
 *
 * `deriveLiveness` is the ONE place "is Claude working?" is computed; PUSH
 * (session:health SSE) and PULL (/api/health) both project from it. These tests
 * drive the private computation + the public getLiveness accessor and assert the
 * five phases, the null-when-idle strip anchor (review Finding 2), the shell-vs-
 * agentic background rule (Defect A), and seq monotonicity (PUSH bumps, PULL reads).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent, type SessionHealthEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  const s = mgr.getOrCreate(id);
  s.q = {}; // truthy — processAlive / live-query gates
  return s;
}

function captureHealth() {
  const events: SessionHealthEvent[] = [];
  const listener = (e: AppEvent) => { if (e.type === 'session:health') events.push(e); };
  eventBus.onApp(listener);
  return { events, stop: () => eventBus.offApp(listener) };
}

const makeBuffer = (startedAt: number, isActive = true) => ({
  userPrompt: 'x', accumulatedText: '', events: [], isActive, startedAt,
});

const bg = (tasks: Array<{ id: string; type: string }>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: tasks.map((t) => ({ task_id: t.id, task_type: t.type, description: 'x' })),
});

afterEach(() => {
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

describe('deriveLiveness — the single liveness projection', () => {
  it('phase idle when nothing is active; startedAt is null (no stale anchor)', () => {
    newSession('lv-idle');
    const lv = sdkSessionManager.getLiveness('lv-idle');
    expect(lv?.phase).toBe('idle');
    expect(lv?.startedAt).toBeNull();
    expect(lv?.mainTurnActive).toBe(false);
    expect(lv?.backgroundAgentic).toBe(false);
    expect(lv?.processAlive).toBe(true);
  });

  it('phase main-turn while the main turn processes; startedAt = the buffer start', () => {
    const s = newSession('lv-main');
    s.isProcessing = true;
    s.streamBuffer = makeBuffer(111);
    const lv = sdkSessionManager.getLiveness('lv-main');
    expect(lv?.phase).toBe('main-turn');
    expect(lv?.mainTurnActive).toBe(true);
    expect(lv?.startedAt).toBe(111);
  });

  it('phase background when only agentic background work runs (main idle)', () => {
    const s = newSession('lv-bg');
    mgr.handle(s, bg([{ id: 'sub1', type: 'subagent' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now(); // fresh — within the grace
    s.streamBuffer = makeBuffer(222, false); // a FINISHED main turn's closed buffer
    const lv = sdkSessionManager.getLiveness('lv-bg');
    expect(lv?.phase).toBe('background');
    expect(lv?.backgroundAgentic).toBe(true);
    // The anchor must be NULL here even though phase is non-idle: the main turn is
    // finished, so its startedAt (222) would strip the completed answer if reused
    // (review Finding 2 reborn). Only the main-turn phase carries an anchor.
    expect(lv?.startedAt).toBeNull();
  });

  it('a detached-shell-only set stays idle (Defect A: shells are not Claude work)', () => {
    const s = newSession('lv-shell');
    mgr.handle(s, bg([{ id: 'sh1', type: 'shell' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now();
    const lv = sdkSessionManager.getLiveness('lv-shell');
    expect(lv?.phase).toBe('idle');
    expect(lv?.backgroundAgentic).toBe(false);
    expect(lv?.startedAt).toBeNull();
  });

  it('main turn takes precedence over concurrent background work in the phase', () => {
    const s = newSession('lv-both');
    mgr.handle(s, bg([{ id: 'sub1', type: 'subagent' }]));
    s.isProcessing = true;
    s.lastBgActivityAt = Date.now();
    s.streamBuffer = makeBuffer(444);
    const lv = sdkSessionManager.getLiveness('lv-both');
    expect(lv?.phase).toBe('main-turn');
    expect(lv?.mainTurnActive).toBe(true);
    expect(lv?.backgroundAgentic).toBe(true); // both facts true; phase picks main
  });

  it('processAlive stays true for a WARM-idle session (query nulled, PID alive)', () => {
    // The badge/dots disagreement SSOT kills: `s.q` is nulled between/around turns
    // while the CLI process is still warm. processAlive must follow the PID (the
    // sidebar badge source), not the transient query object.
    const s = newSession('lv-proc');
    const procs = (sdkSessionManager as unknown as { spawnedProcs: Map<number, string> }).spawnedProcs;
    procs.set(process.pid, 'lv-proc'); // process.pid is a guaranteed-alive stand-in
    s.q = null; // query ended between turns, but the process lives on
    expect(sdkSessionManager.getLiveness('lv-proc')?.processAlive).toBe(true);
    procs.delete(process.pid);
    // No live query AND no warm pid ⇒ genuinely dead.
    expect(sdkSessionManager.getLiveness('lv-proc')?.processAlive).toBe(false);
  });

  it('getLiveness returns null for an unknown session (client falls back to legacy)', () => {
    expect(sdkSessionManager.getLiveness('no-such-session')).toBeNull();
  });

  it('the mainTurnActive override lets the pull route pass its own isProcessing', () => {
    const s = newSession('lv-override');
    s.isProcessing = false; // SDK flag idle…
    s.streamBuffer = makeBuffer(333);
    // …but the route computed isProcessing true (CLI manager OR). The projection
    // must reflect what the route ships in the same response.
    const lv = sdkSessionManager.getLiveness('lv-override', true);
    expect(lv?.phase).toBe('main-turn');
    expect(lv?.mainTurnActive).toBe(true);
    expect(lv?.startedAt).toBe(333);
  });
});

describe('liveness seq — monotonic on PUSH, read-only on PULL', () => {
  it('emitHealth bumps seq each emit and carries the projection on the event', () => {
    const s = newSession('seq-1');
    s.isProcessing = true;
    s.streamBuffer = makeBuffer(10);
    const cap = captureHealth();
    mgr.emitHealth(s, true);
    mgr.emitHealth(s, true);
    cap.stop();
    const evs = cap.events.filter((e) => e.sessionId === 'seq-1');
    expect(evs.length).toBe(2);
    expect(evs[0].liveness?.seq).toBe(1);
    expect(evs[1].liveness?.seq).toBe(2);
    expect(evs[1].liveness?.phase).toBe('main-turn');
  });

  it('getLiveness (PULL) does NOT advance seq', () => {
    const s = newSession('seq-2');
    const cap = captureHealth();
    mgr.emitHealth(s, false); // seq → 1
    cap.stop();
    const before = sdkSessionManager.getLiveness('seq-2')!.seq;
    const after = sdkSessionManager.getLiveness('seq-2')!.seq;
    expect(before).toBe(1);
    expect(after).toBe(1); // pulls are read-only
  });

  it('a PULL can return fresher phase at an UNCHANGED seq (pulls apply unconditionally)', () => {
    const s = newSession('seq-3');
    mgr.handle(s, bg([{ id: 'sub1', type: 'subagent' }]));
    s.isProcessing = false;
    s.lastBgActivityAt = Date.now();
    const cap = captureHealth();
    mgr.emitHealth(s, false); // push: seq=1, phase=background
    cap.stop();
    const pushed = cap.events.find((e) => e.sessionId === 'seq-3')!.liveness!;
    expect(pushed.phase).toBe('background');
    // State moves WITHOUT a push: the background set goes stale and self-heals on read.
    s.lastBgActivityAt = Date.now() - 4 * 60_000;
    const pulled = sdkSessionManager.getLiveness('seq-3', false)!;
    expect(pulled.phase).toBe('idle');   // fresher than the last push…
    expect(pulled.seq).toBe(pushed.seq); // …at the SAME seq. So a client gating on
    // seq>current would WRONGLY ignore this pull — the contract is: apply pulls
    // unconditionally, gate only SSE beats on seq (design doc §3).
  });

  it('PUSH and PULL agree on the projection within a stable state', () => {
    const s = newSession('agree-1');
    s.isProcessing = true;
    s.streamBuffer = makeBuffer(77);
    const cap = captureHealth();
    mgr.emitHealth(s, true);
    cap.stop();
    const pushed = cap.events.find((e) => e.sessionId === 'agree-1')!.liveness!;
    const pulled = sdkSessionManager.getLiveness('agree-1', true)!;
    expect(pulled.phase).toBe(pushed.phase);
    expect(pulled.startedAt).toBe(pushed.startedAt);
    expect(pulled.backgroundAgentic).toBe(pushed.backgroundAgentic);
    expect(pulled.seq).toBe(pushed.seq); // pull reads the last-emitted seq
  });
});
