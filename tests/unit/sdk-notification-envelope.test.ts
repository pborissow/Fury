/**
 * Logical-task ENVELOPE + notification-turn boundary smoothing
 * (docs/ticket-subagent-notification-turns-intermediate-bubbles.md).
 *
 * Since Claude Code 2.1.26x, Task subagents run as background tasks and each
 * <task-notification> completion drives its OWN turn — one user send produces
 * MANY result-terminated turns (the live repro: 1 send, 7 results). Drives the
 * private handle() directly (as sdk-background-turn-reassert.test.ts does) and
 * asserts the projection-level invariants the live suite binds to:
 *
 *   - the envelope opens at the task's first turn and its anchor NEVER moves
 *     across the task's later (notification) turns;
 *   - an intermediate turn's `result` leaves the projection NON-idle
 *     ('background') while tasks are still registered OR a notification turn is
 *     expected — no idle flash at the boundary (the dark-dot gap / mid-envelope
 *     idle from the 2026-09-04 suite run);
 *   - `startedAt` stays null in the smoothed 'background' phase (the dual-
 *     session spec's assertion 6 — no strip anchor on a finished turn);
 *   - the FINAL result (no tasks, nothing pending) closes the envelope
 *     immediately — the reveal is not delayed by any grace;
 *   - `queued_turn_count > 0` on a success result also holds the envelope open;
 *   - interrupt() closes the envelope (the user ended the task on purpose).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent, type SessionHealthEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  return mgr.getOrCreate(id);
}

function captureHealth() {
  const events: SessionHealthEvent[] = [];
  const listener = (e: AppEvent) => { if (e.type === 'session:health') events.push(e); };
  eventBus.onApp(listener);
  return { events, stop: () => eventBus.offApp(listener) };
}

let cap: ReturnType<typeof captureHealth>;
beforeEach(() => { cap = captureHealth(); });
afterEach(() => {
  cap.stop();
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

const messageStart = () => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_start', message: { id: `m-${Math.random()}`, usage: {} } },
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  parent_tool_use_id: null,
  subtype: 'success',
  ...extra,
});
const bgChanged = (ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  // 'local_agent' is the pinned wire value for Task subagents (2026-09-09).
  tasks: ids.map((id) => ({ task_id: id, task_type: 'local_agent', description: 'scout' })),
});
const bgChangedBash = (ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: 'shell' })),
});
/** Terminal task_notification edge — follows the level shrink on the wire. */
const notifEdge = (id: string, status = 'completed') => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status,
});

describe('logical-task envelope across notification turns', () => {
  it('holds one envelope + a non-idle projection across the whole scout fan-out shape', () => {
    const s = newSession('env-fanout');

    // Turn 1 begins while idle (stands in for the user send's turn — same
    // reassert path a notification turn uses; sendMessage spawns a real CLI so
    // it can't run under the unit suite).
    mgr.handle(s, messageStart());
    const anchor = s.envelopeStartedAt;
    expect(typeof anchor).toBe('number');
    expect(mgr.getLiveness('env-fanout')?.envelopeStartedAt).toBe(anchor);
    expect(mgr.getLiveness('env-fanout')?.phase).toBe('main-turn');

    // Scouts dispatched as background tasks; turn 1 ends ("scouts dispatched,
    // waiting…"). The projection must read 'background', not idle.
    mgr.handle(s, bgChanged(['scout-a', 'scout-b']));
    mgr.handle(s, result());
    let lv = mgr.getLiveness('env-fanout');
    expect(lv?.phase).toBe('background');
    expect(lv?.startedAt).toBeNull(); // no strip anchor on a finished turn
    expect(lv?.envelopeStartedAt).toBe(anchor);

    // Scout A completes (wire shape: level shrink, then terminal edge) → its
    // notification turn (#2) runs. The envelope anchor must NOT move to the
    // notification turn's own start.
    mgr.handle(s, bgChanged(['scout-b']));
    mgr.handle(s, notifEdge('scout-a'));
    mgr.handle(s, messageStart());
    expect(s.envelopeStartedAt).toBe(anchor);
    expect(mgr.getLiveness('env-fanout')?.phase).toBe('main-turn');
    mgr.handle(s, result());
    // Boundary tick: scout B still registered → 'background', envelope open.
    lv = mgr.getLiveness('env-fanout');
    expect(lv?.phase).toBe('background');
    expect(lv?.envelopeStartedAt).toBe(anchor);

    // Scout B completes → set EMPTIES while its notification turn (#3) is still
    // imminent. THIS is the boundary that used to flash idle (darkGap): no
    // tasks, no main turn — the bridge covers the level→edge beat and the
    // expected-notification hold covers edge→turn.
    mgr.handle(s, bgChanged([]));
    lv = mgr.getLiveness('env-fanout'); // between level and edge: bridge holds
    expect(lv?.phase).toBe('background');
    expect(lv?.envelopeStartedAt).toBe(anchor);
    mgr.handle(s, notifEdge('scout-b'));
    lv = mgr.getLiveness('env-fanout');
    expect(lv?.phase).toBe('background');
    expect(lv?.envelopeStartedAt).toBe(anchor);

    // Notification turn #3 arrives (consumes the hold) and finishes the task.
    mgr.handle(s, messageStart());
    expect(s.pendingNotifications).toBe(0);
    mgr.handle(s, result());

    // FINAL result: quiescent — no grace delays the reveal. (In test time the
    // 2s level→edge bridge from the last shrink is still ticking; in production
    // the notification turn itself outlives it. Expire it to assert the state.)
    s.notifBridgeUntil = 0;
    lv = mgr.getLiveness('env-fanout');
    expect(lv?.phase).toBe('idle');
    expect(lv?.envelopeStartedAt).toBeNull();
    expect(s.envelopeStartedAt).toBeNull();

    // The PUSH stream agreed at every boundary: no emitted level inside the
    // envelope read phase 'idle'; the one terminal idle carries a null envelope.
    const mine = cap.events.filter((e) => e.sessionId === 'env-fanout');
    const phases = mine.map((e) => e.liveness?.phase);
    expect(phases.filter((p) => p === 'idle')).toHaveLength(1);
    expect(phases[phases.length - 1]).toBe('idle');
    expect(mine[mine.length - 1].liveness?.envelopeStartedAt).toBeNull();
    for (const e of mine.slice(0, -1)) {
      expect(e.liveness?.envelopeStartedAt, 'envelope anchor stable across the task').toBe(anchor);
    }
  });

  it('queued_turn_count > 0 on a success result holds the envelope open for the queued turn', () => {
    const s = newSession('env-queued');
    mgr.handle(s, messageStart());
    const anchor = s.envelopeStartedAt;

    // No background tasks at all — the queued-send signal alone must hold it.
    mgr.handle(s, result({ queued_turn_count: 1 }));
    let lv = mgr.getLiveness('env-queued');
    expect(lv?.phase).toBe('background');
    expect(lv?.envelopeStartedAt).toBe(anchor);

    // The queued turn streams and completes → idle, envelope closed.
    mgr.handle(s, messageStart());
    mgr.handle(s, result());
    lv = mgr.getLiveness('env-queued');
    expect(lv?.phase).toBe('idle');
    expect(lv?.envelopeStartedAt).toBeNull();
  });

  it('the expected-notification hold self-heals after its grace — dots cannot wedge on', () => {
    const s = newSession('env-heal');
    mgr.handle(s, messageStart());
    mgr.handle(s, bgChanged(['t1']));
    mgr.handle(s, result());
    mgr.handle(s, bgChanged([]));
    mgr.handle(s, notifEdge('t1')); // notification predicted…
    expect(mgr.getLiveness('env-heal')?.phase).toBe('background');

    // …but its turn never arrives (batched away / lost).
    s.notifExpectedUntil = Date.now() - 1;
    s.notifBridgeUntil = 0;
    const lv = mgr.getLiveness('env-heal');
    expect(lv?.phase).toBe('idle');
    expect(lv?.envelopeStartedAt).toBeNull();
    expect(s.pendingNotifications).toBe(0);
  });

  it('a SHELL-ONLY background wait releases the envelope — the finished answer reveals under the dots', () => {
    // The "Form Refinement" incident (2026-09-09, session 9f894cd2): the turn
    // ended with dead local_bash tasks still registered; the envelope hid the
    // completed answer for the whole 120s wedge grace. Model output is done in
    // a shell-only wait — the envelope must release (phase may STAY background:
    // a detached shell is liveness per the 2026-08-21 decision).
    const s = newSession('env-shell-only');
    mgr.handle(s, messageStart());
    expect(typeof s.envelopeStartedAt).toBe('number');
    // A backgrounded shell is running as the turn ends; its terminal signal is lost.
    mgr.handle(s, bgChangedBash(['build-1']));
    mgr.handle(s, result());
    s.notifBridgeUntil = 0; // no departure happened; belt-and-braces for test time

    const lv = mgr.getLiveness('env-shell-only');
    expect(lv?.phase).toBe('background');      // dots stay — shell is liveness
    expect(lv?.envelopeStartedAt).toBeNull();  // …but the answer is REVEALED
    expect(s.envelopeStartedAt ?? null).toBeNull();

    // An AGENTIC wait in the same shape must keep hiding (the ticket's case).
    const s2 = newSession('env-agent-wait');
    mgr.handle(s2, messageStart());
    const anchor2 = s2.envelopeStartedAt;
    mgr.handle(s2, bgChanged(['scout-1']));
    mgr.handle(s2, result());
    const lv2 = mgr.getLiveness('env-agent-wait');
    expect(lv2?.phase).toBe('background');
    expect(lv2?.envelopeStartedAt).toBe(anchor2); // still hidden while scouts run
  });

  it('interrupt() closes the envelope — a deliberately stopped task reveals its history', async () => {
    const s = newSession('env-interrupt');
    mgr.handle(s, messageStart());
    expect(typeof s.envelopeStartedAt).toBe('number');

    await mgr.interrupt('env-interrupt');
    expect(s.envelopeStartedAt).toBeNull();
    expect(s.pendingNotifications).toBe(0);
    const last = cap.events.filter((e) => e.sessionId === 'env-interrupt').at(-1);
    expect(last?.liveness?.envelopeStartedAt).toBeNull();
  });

  it('interrupt() mid-fan-out: the reveal survives — the backstop must not re-anchor at the stopped turn', async () => {
    // Review 2026-09-08, Bug 1: interrupt() deliberately does NOT clear
    // backgroundTasks (the scouts may genuinely still run), so its own
    // emitHealth lands in phase 'background' and deriveLiveness's backstop
    // re-opens an envelope IN THE SAME CALL that the null just closed. That
    // envelope must anchor at NOW (hiding only future notification-turn
    // output) — anchoring at the closed buffer's startedAt would re-hide the
    // very output the user hit stop to look at.
    const s = newSession('env-interrupt-bg');
    mgr.handle(s, messageStart());          // turn streaming, envelope open
    mgr.handle(s, bgChanged(['scout-a']));  // scouts registered + grace fresh
    // Age the turn so a wrong re-anchor is distinguishable from "now".
    s.streamBuffer.startedAt = Date.now() - 60_000;
    s.envelopeStartedAt = s.streamBuffer.startedAt;

    const tStop = Date.now();
    await mgr.interrupt('env-interrupt-bg');

    const last = cap.events.filter((e) => e.sessionId === 'env-interrupt-bg').at(-1);
    expect(last?.liveness?.phase).toBe('background'); // scouts keep the dots — by design
    const anchor = last?.liveness?.envelopeStartedAt;
    expect(typeof anchor).toBe('number');
    expect(anchor as number).toBeGreaterThanOrEqual(tStop); // fresh span only
    expect(anchor).not.toBe(s.streamBuffer?.startedAt);     // never the stopped turn's start
  });

  it('a late background signal on an idle session opens a FRESH envelope — the settled answer stays revealed', () => {
    // Review 2026-09-08, Bug 2: an idle session whose finished answer is on
    // screen still holds that turn's start in its (closed) stream buffer. A
    // non-idle transition arriving OUTSIDE sendMessage/reassertProcessing must
    // not anchor the envelope there — that would slice the already-revealed
    // answer out of the main flow.
    const s = newSession('env-late-signal');
    s.isProcessing = false;
    s.streamBuffer = {
      userPrompt: 'earlier prompt',
      accumulatedText: '',
      events: [],
      isActive: false, // closeBuffer() retains the object — the trap
      startedAt: Date.now() - 300_000,
    };
    expect(s.envelopeStartedAt ?? null).toBeNull();

    const t0 = Date.now();
    mgr.handle(s, bgChanged(['late-shell']));
    const lv = mgr.getLiveness('env-late-signal');
    expect(lv?.phase).toBe('background');
    expect(typeof lv?.envelopeStartedAt).toBe('number');
    expect(lv?.envelopeStartedAt as number).toBeGreaterThanOrEqual(t0); // not the finished turn's start
  });

  it('a notification turn arriving from TRUE idle opens its own envelope at its start', () => {
    const s = newSession('env-late');
    expect(s.envelopeStartedAt ?? null).toBeNull();
    // e.g. a detached shell finishing long after the last turn settled.
    mgr.handle(s, messageStart());
    const anchor = s.envelopeStartedAt;
    expect(typeof anchor).toBe('number');
    expect(anchor).toBe(s.streamBuffer?.startedAt); // this turn IS the envelope's first
    mgr.handle(s, result());
    expect(s.envelopeStartedAt).toBeNull(); // one-turn task, closed at its result
  });
});
