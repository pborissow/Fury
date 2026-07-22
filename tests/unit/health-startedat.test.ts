/**
 * session:health carries the turn's startedAt anchor
 * (docs/ticket-inflight-partials-health-startedat.md, Part A).
 *
 * The client's latch-break re-strip anchors on this value; before the fix the
 * event shipped without it, so the strip fell back to the trailing-assistant
 * heuristic that can cut an earlier completed turn. Drives the private emitHealth
 * directly and captures the eventBus (as sdk-error-surfacing.test.ts does).
 */
import { describe, it, expect, afterEach } from 'vitest';
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

const makeBuffer = (startedAt: number) => ({
  userPrompt: 'x',
  accumulatedText: '',
  events: [],
  isActive: true,
  startedAt,
});

afterEach(() => {
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

describe('emitHealth carries the turn startedAt', () => {
  it('session:health {isProcessing:true} includes streamBuffer.startedAt', () => {
    const s = newSession('health-1');
    s.streamBuffer = makeBuffer(1_720_000_000_000);
    const cap = captureHealth();
    mgr.emitHealth(s, true);
    cap.stop();

    const ev = cap.events.find((e) => e.sessionId === 'health-1');
    expect(ev, 'a health event was emitted').toBeTruthy();
    expect(ev!.isProcessing).toBe(true);
    expect(ev!.startedAt).toBe(1_720_000_000_000);
  });

  it('the anchor equals what /api/stream-buffer reports (same buffer.startedAt)', () => {
    const s = newSession('health-2');
    s.streamBuffer = makeBuffer(1_720_000_012_345);
    // /api/stream-buffer returns getStreamBuffer(id).startedAt — assert the health
    // event uses the identical value, or restore and latch-break would disagree.
    const fromBufferRoute = mgr.getStreamBuffer('health-2').startedAt;
    const cap = captureHealth();
    mgr.emitHealth(s, true);
    cap.stop();

    const ev = cap.events.find((e) => e.sessionId === 'health-2');
    expect(ev!.startedAt).toBe(fromBufferRoute);
  });

  it('startedAt is undefined when there is no buffer (no anchor to give)', () => {
    const s = newSession('health-3');
    s.streamBuffer = undefined;
    const cap = captureHealth();
    mgr.emitHealth(s, false);
    cap.stop();

    const ev = cap.events.find((e) => e.sessionId === 'health-3');
    expect(ev!.startedAt).toBeUndefined();
  });
});
