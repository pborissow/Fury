/**
 * Background-task turns re-assert processing (docs/ticket-background-task-
 * notification-turns-render-dark.md).
 *
 * Drives the private handle() directly (as sdk-error-surfacing.test.ts does) and
 * captures the eventBus. The bug: the SDK runs turns the user never submitted (a
 * background Monitor/Bash/subagent posting a <task-notification>), each emitting
 * its own `result`. Pre-fix, only the submit path turned dots on, so after the
 * first result the session flipped idle and stayed dark while later turns streamed
 * — their partial assistant messages leaking as intermediary bubbles.
 *
 * Asserts:
 *   - a main-thread stream event (message_start / content_block_delta) after a
 *     result RE-ASSERTS processing: a session:health {isProcessing:true} with a
 *     fresh numeric startedAt is emitted (pre-fix: none);
 *   - a sidechain (parent_tool_use_id set) stream event does NOT re-assert;
 *   - a normal submitted, already-processing turn does not double-emit health
 *     (the re-assert only fires while idle);
 *   - `result` emits idle only when transitioning from processing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

/** Capture session:health events while a test runs. */
function captureHealth(): {
  health: { isProcessing: boolean; startedAt?: number }[];
  stop: () => void;
} {
  const health: { isProcessing: boolean; startedAt?: number }[] = [];
  const listener = (e: AppEvent) => {
    if (e.type === 'session:health') health.push({ isProcessing: e.isProcessing, startedAt: e.startedAt });
  };
  eventBus.onApp(listener);
  return { health, stop: () => eventBus.offApp(listener) };
}

const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  return mgr.getOrCreate(id);
}

let cap: ReturnType<typeof captureHealth>;
beforeEach(() => { cap = captureHealth(); });
afterEach(() => {
  cap.stop();
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

const messageStart = (parentId: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parentId,
  event: { type: 'message_start', message: { id: `m-${Math.random()}`, usage: {} } },
});

const successResult = () => ({ type: 'result', parent_tool_use_id: null, subtype: 'success' });

describe('background-task turn re-asserts processing', () => {
  it('re-emits session:health {isProcessing:true, startedAt} when a turn streams after a result', () => {
    const s = newSession('bg-reassert-1');
    // Simulate an in-flight turn (submit path already turned dots on).
    s.isProcessing = true;

    // Main turn ends.
    mgr.handle(s, successResult());
    // A notification-driven turn begins streaming while the session is idle.
    mgr.handle(s, messageStart(null));

    // Idle from the result, then processing from the re-assert.
    expect(cap.health.map(h => h.isProcessing)).toEqual([false, true]);
    const reassert = cap.health[1];
    expect(reassert.isProcessing).toBe(true);
    expect(typeof reassert.startedAt).toBe('number');
    expect(reassert.startedAt).toBeGreaterThan(0);
    expect(s.isProcessing).toBe(true);
    // A fresh buffer was reopened so the client can strip this turn's partials.
    expect(s.streamBuffer?.isActive).toBe(true);
    expect(s.streamBuffer?.startedAt).toBe(reassert.startedAt);
  });

  it('a sidechain (parent_tool_use_id set) stream event does NOT re-assert processing', () => {
    const s = newSession('bg-reassert-sub');
    s.isProcessing = true;
    mgr.handle(s, successResult()); // -> idle

    // A forwarded subagent block must not flip the main session live again.
    mgr.handle(s, messageStart('toolu_sub'));

    expect(cap.health.map(h => h.isProcessing)).toEqual([false]);
    expect(s.isProcessing).toBe(false);
  });

  it('does not double-emit health for a normal, already-processing submitted turn', () => {
    const s = newSession('bg-reassert-normal');
    // Mid-submitted-turn: isProcessing is already true before any event.
    s.isProcessing = true;

    mgr.handle(s, messageStart(null));
    mgr.handle(s, messageStart(null));

    // The re-assert only fires while idle, so no health event is emitted here.
    expect(cap.health).toHaveLength(0);
    expect(s.isProcessing).toBe(true);
  });

  it('result emits idle only when transitioning from processing', () => {
    const s = newSession('bg-reassert-idle-gate');
    // Already idle: a stray result must not emit a redundant idle event.
    s.isProcessing = false;
    mgr.handle(s, successResult());
    expect(cap.health).toHaveLength(0);
  });
});
