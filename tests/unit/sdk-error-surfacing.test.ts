/**
 * SDK error surfacing (docs/ticket-sdk-error-surfacing-improvements.md).
 *
 * Drives the private handle() directly (as context-window-model-switch.test.ts
 * does) and captures the eventBus, since the auth path can't be reproduced on
 * demand with valid credentials. Asserts:
 *   - assistant errors are detected via the typed `error` field, not the model
 *     string, and mapped to a clear message;
 *   - result errors read errors[]/terminal_reason, not the generic fallback;
 *   - api_retry is NOT surfaced and does not latch turnErrorEmitted;
 *   - an assistant error + error result surfaces exactly once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent } from '../../lib/eventBus';

const mgr = sdkSessionManager as any;

/** Capture session:stream {error} strings for a given session while `fn` runs. */
function captureErrors(): { errors: string[]; stop: () => void } {
  const errors: string[] = [];
  const listener = (e: AppEvent) => {
    if (e.type === 'session:stream' && typeof e.error === 'string') errors.push(e.error);
  };
  eventBus.onApp(listener);
  return { errors, stop: () => eventBus.offApp(listener) };
}

// Track and remove every session these tests mint so the singleton's map doesn't
// accrue phantom sessions for the rest of the run (mirrors handoff-ownership).
const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  return mgr.getOrCreate(id);
}

let cap: ReturnType<typeof captureErrors>;
beforeEach(() => { cap = captureErrors(); });
afterEach(() => {
  cap.stop();
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
});

const assistantError = (code: string, text = '') => ({
  type: 'assistant',
  parent_tool_use_id: null,
  error: code,
  message: { id: `m-${code}-${Math.random()}`, model: '<synthetic>', content: text ? [{ type: 'text', text }] : [] },
});

const resultError = (fields: Record<string, unknown>) => ({
  type: 'result',
  parent_tool_use_id: null,
  subtype: 'error_during_execution',
  ...fields,
});

describe('assistant error detection (typed field, not model string)', () => {
  it('surfaces a clear auth message for error:authentication_failed', () => {
    const s = newSession('err-auth-1');
    mgr.handle(s, assistantError('authentication_failed', 'OAuth session expired'));
    expect(s.turnErrorEmitted).toBe(true);
    expect(cap.errors).toHaveLength(1);
    expect(cap.errors[0]).toMatch(/Authentication failed/i);
    expect(cap.errors[0]).toMatch(/\/login/);
  });

  it('detects the error even when the model is NOT the literal <synthetic>', () => {
    const s = newSession('err-auth-2');
    // A real model id + a typed error code — the old model==='<synthetic>' gate
    // would have missed this entirely.
    mgr.handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      error: 'billing_error',
      message: { id: 'm-bill', model: 'claude-opus-4-8', content: [] },
    });
    expect(cap.errors).toHaveLength(1);
    expect(cap.errors[0]).toMatch(/Billing error/i);
  });

  it('does NOT surface a benign <synthetic> message with no text and no error code', () => {
    const s = newSession('err-benign');
    // e.g. a compaction stub / "no response requested": model <synthetic>, no
    // error field, no text. Must stay silent.
    mgr.handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm-stub', model: '<synthetic>', content: [] },
    });
    expect(cap.errors).toHaveLength(0);
    expect(s.turnErrorEmitted).toBeFalsy();
  });

  it('legacy fallback: a <synthetic> message WITH text but no code still surfaces', () => {
    const s = newSession('err-legacy');
    mgr.handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm-legacy', model: '<synthetic>', content: [{ type: 'text', text: 'Something broke' }] },
    });
    expect(cap.errors).toEqual(['Something broke']);
  });

  it('ignores a subagent (sidechain) error — not a main-turn failure', () => {
    const s = newSession('err-sub');
    mgr.handle(s, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_sub',
      error: 'authentication_failed',
      message: { id: 'm-sub', model: '<synthetic>', content: [{ type: 'text', text: 'x' }] },
    });
    expect(cap.errors).toHaveLength(0);
  });
});

describe('result error detail (errors[]/terminal_reason, not the generic fallback)', () => {
  it('surfaces the joined errors[] text', () => {
    const s = newSession('res-err-1');
    mgr.handle(s, resultError({ errors: ['disk full', 'write failed'] }));
    expect(cap.errors).toEqual(['disk full; write failed']);
  });

  it('falls back to terminal_reason when errors[] is empty', () => {
    const s = newSession('res-err-2');
    mgr.handle(s, resultError({ errors: [], terminal_reason: 'prompt_too_long' }));
    expect(cap.errors).toEqual(['terminated: prompt_too_long']);
  });

  it('uses the generic fallback only when nothing else is present', () => {
    const s = newSession('res-err-3');
    mgr.handle(s, resultError({ subtype: 'error_max_turns' }));
    expect(cap.errors).toEqual(['Turn ended with error (error_max_turns).']);
  });
});

describe('api_retry is transient, not fatal', () => {
  it('does not surface an error and does not latch turnErrorEmitted', () => {
    const s = newSession('retry-1');
    mgr.handle(s, {
      type: 'system',
      subtype: 'api_retry',
      error: 'overloaded',
      error_status: 529,
      attempt: 1,
      max_retries: 5,
      retry_delay_ms: 1000,
    });
    expect(cap.errors).toHaveLength(0);
    expect(s.turnErrorEmitted).toBeFalsy();
  });
});

describe('transient assistant errors (rate_limit / overloaded) are not surfaced as fatal', () => {
  // These codes also arrive as api_retry and can recover. If surfaced here, the
  // success result would never clear the bubble (turnErrorEmitted is sticky), so
  // it must stay silent and let a genuinely terminal case come via the result.
  for (const code of ['rate_limit', 'overloaded'] as const) {
    it(`an assistant error:${code} that then succeeds leaves NO stuck error bubble`, () => {
      const s = newSession(`transient-${code}`);
      mgr.handle(s, assistantError(code, 'temporarily unavailable'));
      // The turn recovers and finishes successfully.
      mgr.handle(s, { type: 'result', parent_tool_use_id: null, subtype: 'success' });
      expect(cap.errors, `${code} must not surface a fatal bubble`).toHaveLength(0);
      expect(s.turnErrorEmitted, 'turnErrorEmitted stays clear so a later real error can surface').toBeFalsy();
    });
  }

  it('a TERMINAL rate limit still surfaces — via the non-success result', () => {
    const s = newSession('transient-terminal');
    mgr.handle(s, assistantError('rate_limit', 'slow down'));
    mgr.handle(s, resultError({ errors: ['rate limit exceeded after retries'] }));
    expect(cap.errors).toEqual(['rate limit exceeded after retries']);
  });
});

describe('no double-surface', () => {
  it('an assistant error followed by an error result emits once', () => {
    const s = newSession('once-1');
    mgr.handle(s, assistantError('authentication_failed', 'OAuth expired'));
    mgr.handle(s, resultError({ errors: ['downstream failure after auth'] }));
    expect(cap.errors).toHaveLength(1);
    expect(cap.errors[0]).toMatch(/Authentication failed/i);
  });
});
