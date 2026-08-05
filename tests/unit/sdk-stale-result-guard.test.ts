/**
 * Turn-identity (epoch) guard on the `result` handler (P2) and the related
 * suppressed-error-after-Stop behavior (P6).
 *
 * interrupt() deliberately keeps the query alive ("the message stream stays open
 * for the next turn"), so a stopped turn's trailing `result` can still reach
 * handle() AFTER the user re-sent and a fresh turn is already under way. Without a
 * turn-identity guard that stale result tears down the NEW turn: isProcessing
 * flips false, the buffer closes, and the new turn's partials leak as bubbles.
 *
 * The guard: a `result` only ends the current turn when the current epoch has
 * itself produced main-thread output (streamedEpoch === turnEpoch). A stale result
 * arrives before the new turn streams, so its epoch trails and it is ignored.
 *
 * Drives the private handle()/interrupt() directly, mirroring
 * sdk-background-turn-reassert.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

function capture(): {
  health: { isProcessing: boolean }[];
  errors: string[];
  stop: () => void;
} {
  const health: { isProcessing: boolean }[] = [];
  const errors: string[] = [];
  const listener = (e: AppEvent) => {
    if (e.type === 'session:health') health.push({ isProcessing: e.isProcessing });
    if (e.type === 'session:stream' && e.error) errors.push(e.error);
  };
  eventBus.onApp(listener);
  return { health, errors, stop: () => eventBus.offApp(listener) };
}

const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  return mgr.getOrCreate(id);
}

let cap: ReturnType<typeof capture>;
beforeEach(() => { cap = capture(); });
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
const errorResult = () => ({
  type: 'result',
  parent_tool_use_id: null,
  subtype: 'error_during_execution',
  errors: ['boom'],
});

/** Put a session into "turn A is streaming" state through the real code paths. */
function startStreamingTurn(s: any) {
  s.turnEpoch++;           // sendMessage bumps the epoch at turn start
  s.isProcessing = true;
  s.streamBuffer = { userPrompt: 'a', accumulatedText: '', events: [], isActive: true, startedAt: Date.now() };
  mgr.handle(s, messageStart(null)); // main-thread output → streamedEpoch = turnEpoch
}

describe('stale result (turn-identity) guard', () => {
  it('a stopped turn’s trailing result does NOT tear down a freshly-started new turn', async () => {
    const s = newSession('stale-1');
    startStreamingTurn(s); // turn A: epoch 1, streamed 1

    // User stops. interrupt() keeps the query alive; s.q is null in the test so
    // the CLI call is skipped, but the flag/health bookkeeping runs.
    await mgr.interrupt('stale-1');
    expect(s.isProcessing).toBe(false);

    // User immediately re-sends → turn B begins (epoch bumped, fresh buffer),
    // but has not streamed yet (streamedEpoch still trails).
    s.turnEpoch++;
    s.isProcessing = true;
    s.turnErrorEmitted = false;
    s.streamBuffer = { userPrompt: 'b', accumulatedText: '', events: [], isActive: true, startedAt: Date.now() };

    // Turn A's trailing result now arrives late.
    mgr.handle(s, successResult());

    // It must be ignored: the new turn stays live and its buffer stays open.
    expect(s.isProcessing).toBe(true);
    expect(s.streamBuffer?.isActive).toBe(true);

    // Turn B then streams and ends normally.
    mgr.handle(s, messageStart(null));
    mgr.handle(s, successResult());
    expect(s.isProcessing).toBe(false);
  });

  it('a stale ERROR result for a superseded (interrupted+resent) turn is swallowed', async () => {
    const s = newSession('stale-2');
    startStreamingTurn(s); // turn A: epoch 1, streamed 1

    await mgr.interrupt('stale-2'); // arms the stale-result guard
    // Turn B started but has not streamed (epoch ahead of streamedEpoch).
    s.turnEpoch++;
    s.isProcessing = true;
    s.turnErrorEmitted = false;

    mgr.handle(s, errorResult()); // superseded → swallowed before the error branch

    expect(cap.errors).toEqual([]);
    expect(s.isProcessing).toBe(true);
  });

  it('a FRESH turn that errors before producing any output is NOT swallowed (R2)', () => {
    const s = newSession('fresh-err');
    // A first turn as sendMessage sets it up: epoch bumped, processing, no output
    // yet, and crucially NO interrupt (so the stale-result guard is not armed).
    s.turnEpoch++;
    s.isProcessing = true;
    s.turnErrorEmitted = false;

    // An error result arrives with no preceding main-thread message. Pre-R2 the
    // epoch guard mistook this for a stale result and swallowed it, hanging the turn
    // until the watchdog. It must instead be processed: error surfaced, dots cleared.
    mgr.handle(s, errorResult());

    expect(cap.errors.length).toBe(1);
    expect(s.isProcessing).toBe(false);
  });

  it('after a user Stop, the SAME turn’s trailing error result is suppressed (P6)', async () => {
    const s = newSession('stale-3');
    startStreamingTurn(s); // turn A: epoch 1, streamed 1

    await mgr.interrupt('stale-3'); // user Stop → marks turnErrorEmitted
    expect(s.turnErrorEmitted).toBe(true);

    // No re-send: turn A's trailing error result arrives with matching epoch, so
    // it is NOT swallowed — but the user-stop flag suppresses the error bubble.
    mgr.handle(s, errorResult());
    expect(cap.errors).toEqual([]);
  });

  it('a normal turn’s own result still ends it (no false positive)', () => {
    const s = newSession('stale-4');
    startStreamingTurn(s);
    mgr.handle(s, successResult());
    expect(s.isProcessing).toBe(false);
  });
});
