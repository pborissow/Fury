/**
 * Pure reducers behind the Chat tab's session-scoped SSE listeners
 * (lib/sessionEvents.ts, docs/ticket-chattab-refactor.md Stage 4). Each test
 * pins a decision the listener used to make inline.
 */
import { describe, it, expect } from 'vitest';
import {
  reduceSessionStream, appendStreamEvent, applyContextUsage, clearContextUsage,
  reduceHealth, reduceHealthPoll, reduceConnected,
} from '../../lib/sessionEvents';
import type { StreamEvent } from '../../components/StreamEventsPanel';

const live = { loading: true, sdkSessionsEnabled: true };

describe('reduceSessionStream', () => {
  it('handles the MCP init signal before the loading guard', () => {
    const servers = [{ name: 'gh', status: 'failed' }];
    expect(reduceSessionStream({ mcpServers: servers }, { ...live, loading: false })).toEqual({ mcpFailed: servers });
    expect(reduceSessionStream({ mcpServers: [] }, live)).toEqual({ mcpFailed: [] }); // recovery
  });

  it('ignores stream data once the turn is no longer loading (stopped)', () => {
    expect(reduceSessionStream({ text: 'late' }, { ...live, loading: false })).toEqual({ ignore: true });
  });

  it('appends text to the buffer and the Stream panel', () => {
    expect(reduceSessionStream({ text: 'hi' }, live)).toEqual({ appendText: 'hi', streamEvent: true });
  });

  it('opens a CLI question from the tool_use only when the SDK backend is off', () => {
    const toolUse = { name: 'AskUserQuestion', status: 'complete', input: { questions: [{ question: 'Q?' }] } };
    expect(reduceSessionStream({ toolUse }, { loading: true, sdkSessionsEnabled: false }))
      .toEqual({ streamEvent: true, ask: { type: 'cli', input: toolUse.input } });
    // SDK on: its own askUserQuestion event (with the toolUseID) opens it instead.
    expect(reduceSessionStream({ toolUse }, live)).toEqual({ streamEvent: true });
    // Not complete yet: no dialog.
    expect(reduceSessionStream({ toolUse: { ...toolUse, status: 'starting' } }, { loading: true, sdkSessionsEnabled: false }))
      .toEqual({ streamEvent: true });
  });

  it('parks or clears an SDK question without a stream event', () => {
    expect(reduceSessionStream({ askUserQuestion: { toolUseID: 't1', questions: [1] } }, live))
      .toEqual({ ask: { type: 'park', toolUseID: 't1', questions: [1] } });
    expect(reduceSessionStream({ askUserQuestion: { cleared: true } }, live)).toEqual({ ask: { type: 'clear' } });
  });

  it('surfaces an error in the conversation as well as the Stream panel', () => {
    expect(reduceSessionStream({ error: 'OAuth expired' }, live)).toEqual({ streamEvent: true, error: 'OAuth expired' });
  });
});

describe('appendStreamEvent', () => {
  const t = (content: string): StreamEvent => ({ type: 'text', content, ts: 1 });

  it('coalesces consecutive text chunks into one event', () => {
    const out = appendStreamEvent([t('Hel')], { text: 'lo' }, 2);
    expect(out).toEqual([{ type: 'text', content: 'Hello', ts: 1 }]);
  });

  it('starts a new text event after a non-text event', () => {
    const prev: StreamEvent[] = [{ type: 'tool_start', name: 'Read', ts: 1 }];
    expect(appendStreamEvent(prev, { text: 'x' }, 5)).toEqual([...prev, { type: 'text', content: 'x', ts: 5 }]);
  });

  it('records tool start/complete, results and errors', () => {
    expect(appendStreamEvent([], { toolUse: { name: 'Read', status: 'starting' } }, 3))
      .toEqual([{ type: 'tool_start', name: 'Read', ts: 3 }]);
    expect(appendStreamEvent([], { toolUse: { name: 'Read', status: 'complete', input: { p: 1 } } }, 3))
      .toEqual([{ type: 'tool_complete', name: 'Read', input: { p: 1 }, ts: 3 }]);
    expect(appendStreamEvent([], { toolResult: { preview: 'ok' } }, 3)).toEqual([{ type: 'tool_result', preview: 'ok', ts: 3 }]);
    expect(appendStreamEvent([], { error: 'boom' }, 3)).toEqual([{ type: 'error', content: 'boom', ts: 3 }]);
  });

  it('returns the same array when nothing is added', () => {
    const prev = [t('a')];
    expect(appendStreamEvent(prev, { toolUse: { name: 'X', status: 'other' } }, 1)).toBe(prev);
    expect(appendStreamEvent(prev, {}, 1)).toBe(prev);
  });
});

describe('context usage', () => {
  it('replaces (absolute level) rather than accumulates', () => {
    const a = applyContextUsage({}, 's', { contextTokens: 100, contextWindow: 1000 });
    expect(applyContextUsage(a, 's', { contextTokens: 250, contextWindow: 1000 })).toEqual({ s: { tokens: 250, window: 1000 } });
  });

  it('keeps the last non-zero window while later events report 0', () => {
    const a = applyContextUsage({}, 's', { contextTokens: 100, contextWindow: 1000 });
    expect(applyContextUsage(a, 's', { contextTokens: 120, contextWindow: 0 })).toEqual({ s: { tokens: 120, window: 1000 } });
  });

  it('ignores payloads without a token count, and no-ops return the same object', () => {
    const a = applyContextUsage({}, 's', { contextTokens: 100, contextWindow: 1000 });
    expect(applyContextUsage(a, 's', {})).toBe(a);
    expect(applyContextUsage(a, 's', { contextTokens: 100, contextWindow: 1000 })).toBe(a);
  });

  it('clearContextUsage drops only that session, and no-ops return the same object', () => {
    const a = { s: { tokens: 1, window: 2 }, t: { tokens: 3, window: 4 } };
    expect(clearContextUsage(a, 's')).toEqual({ t: { tokens: 3, window: 4 } });
    expect(clearContextUsage(a, 'missing')).toBe(a);
  });
});

describe('reduceHealth', () => {
  it('passes stuck state and background work through', () => {
    const out = reduceHealth({ isStuck: true, stuckReason: 'no output', backgroundActive: true }, { loading: true });
    expect(out.isStuck).toBe(true);
    expect(out.stuckReason).toBe('no output');
    expect(out.backgroundWorking).toBe(true);
  });

  it('latch-break: processing while not loading re-strips on startedAt (0 without one)', () => {
    expect(reduceHealth({ isProcessing: true, startedAt: 500 }, { loading: false }).restripAt).toBe(500);
    expect(reduceHealth({ isProcessing: true }, { loading: false }).restripAt).toBe(0);
    expect(reduceHealth({ isProcessing: true, startedAt: 500 }, { loading: true }).restripAt).toBeNull();
  });

  it('ends the turn only on a real terminal idle — not while background work is live (P1)', () => {
    expect(reduceHealth({ isProcessing: false, backgroundActive: false }, { loading: true }).turnEnded).toBe(true);
    expect(reduceHealth({ isProcessing: false, backgroundActive: true }, { loading: true }).turnEnded).toBe(false);
    expect(reduceHealth({ isProcessing: false }, { loading: false }).turnEnded).toBe(false);
  });
});

describe('reduceHealthPoll', () => {
  const legacy = { loading: true, projectionOn: false, falseStreak: 0 };

  it('under the projection, does nothing but the (caller-applied) PULL', () => {
    expect(reduceHealthPoll({ isProcessing: false }, { ...legacy, projectionOn: true, falseStreak: 1 }))
      .toEqual({ falseStreak: 1, teardown: false });
  });

  it('syncs background dots but never tears down when not loading', () => {
    expect(reduceHealthPoll({ backgroundActive: true }, { ...legacy, loading: false }))
      .toEqual({ backgroundWorking: true, falseStreak: 0, teardown: false });
  });

  it('needs TWO consecutive false readings to tear down', () => {
    const first = reduceHealthPoll({ isProcessing: false }, legacy);
    expect(first).toMatchObject({ falseStreak: 1, teardown: false, falseReadingStreak: 1 });
    const second = reduceHealthPoll({ isProcessing: false }, { ...legacy, falseStreak: first.falseStreak });
    expect(second).toMatchObject({ falseStreak: 0, teardown: true, falseReadingStreak: 2 });
  });

  it('a live reading resets the streak (and says so)', () => {
    expect(reduceHealthPoll({ isProcessing: true }, { ...legacy, falseStreak: 1 }))
      .toMatchObject({ falseStreak: 0, teardown: false, resetFromStreak: 1 });
    expect(reduceHealthPoll({ isProcessing: true }, legacy).resetFromStreak).toBeUndefined();
  });

  it('never tears down while background work is live, and resets the streak (Defect B)', () => {
    expect(reduceHealthPoll({ isProcessing: false, backgroundActive: true }, { ...legacy, falseStreak: 1 }))
      .toEqual({ backgroundWorking: true, falseStreak: 0, teardown: false });
  });
});

describe('reduceConnected', () => {
  it('adopts the buffer only when it has more text than we do', () => {
    const buf = { hasBuffer: true, isActive: true, accumulatedText: 'hello' };
    expect(reduceConnected(buf, { streamingLength: 2, loading: true }).restoreStream).toBe(true);
    expect(reduceConnected(buf, { streamingLength: 5, loading: true }).restoreStream).toBe(false);
    expect(reduceConnected({ ...buf, hasBuffer: false }, { streamingLength: 0, loading: true }).restoreStream).toBe(false);
  });

  it('starts loading when processing (session-level OR active buffer)', () => {
    expect(reduceConnected({ isProcessing: true }, { streamingLength: 0, loading: false }).startLoading).toBe(true);
    expect(reduceConnected({ hasBuffer: true, isActive: true }, { streamingLength: 0, loading: false }).startLoading).toBe(true);
  });

  it('detects a turn that completed between restore and connect', () => {
    expect(reduceConnected({ isProcessing: false }, { streamingLength: 0, loading: true })).toMatchObject({ completed: true, startLoading: false });
    expect(reduceConnected({ isProcessing: false }, { streamingLength: 0, loading: false }).completed).toBe(false);
  });
});
