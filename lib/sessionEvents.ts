/**
 * Pure reducers for the Chat tab's session-scoped SSE events
 * (components/chat/hooks/useSessionStream.ts). Each listener parses its payload,
 * asks one of these what the event MEANS given the current state, and applies
 * the answer — so the decision logic is unit-testable without an EventSource,
 * React, or fetch.
 */
import type { StreamEvent } from '@/components/StreamEventsPanel';
import type { Liveness } from './eventBus';

export type McpFailure = { name: string; status: string };

// ---------------------------------------------------------------- session-stream

export interface SessionStreamPayload {
  /** One-shot init signal: the servers that FAILED to connect ([] = recovered). */
  mcpServers?: McpFailure[];
  text?: string;
  toolUse?: { name: string; status: 'starting' | 'complete' | string; input?: any };
  /** SDK: a question parked (with its toolUseID), or `cleared` by someone else. */
  askUserQuestion?: { cleared?: boolean; toolUseID?: string; questions?: any[] };
  toolResult?: { preview?: string };
  error?: string;
}

export type AskAction =
  | { type: 'cli'; input: any }
  | { type: 'park'; toolUseID: string; questions: any[] }
  | { type: 'clear' };

export interface SessionStreamOutcome {
  /** Replace the durable failed-MCP set (B4). Nothing else applies when set. */
  mcpFailed?: McpFailure[];
  /** Stream data arriving after the user stopped the turn — drop it, or it would
   *  overwrite the cleared state. */
  ignore?: boolean;
  /** Append to the in-flight streaming text. */
  appendText?: string;
  /** Update the Stream panel's event list (apply with appendStreamEvent). */
  streamEvent?: boolean;
  ask?: AskAction;
  /** A turn-ending error, also surfaced in the conversation (the parser drops the
   *  SDK's synthetic error message, so this is the only durable surface). */
  error?: string;
}

/**
 * What a `session-stream` event means. `loading`: a main turn is in flight.
 */
export function reduceSessionStream(
  data: SessionStreamPayload,
  { loading, sdkSessionsEnabled }: { loading: boolean; sdkSessionsEnabled: boolean },
): SessionStreamOutcome {
  // MCP status is an init signal, not turn stream data: handled BEFORE the
  // loading guard, and never shown as a stream event.
  if (Array.isArray(data.mcpServers)) return { mcpFailed: data.mcpServers };

  if (!loading) return { ignore: true };

  if (data.text) return { appendText: data.text, streamEvent: true };
  if (data.toolUse) {
    const tool = data.toolUse;
    // CLI PATH ONLY: this event carries no toolUseID, so a dialog opened from it
    // could never resolve an SDK tool call — and the SDK emits its own
    // askUserQuestion event WITH the id, which would race this one.
    const ask: AskAction | undefined =
      tool.status === 'complete' && !sdkSessionsEnabled && tool.name === 'AskUserQuestion' && tool.input?.questions
        ? { type: 'cli', input: tool.input }
        : undefined;
    return { streamEvent: true, ...(ask ? { ask } : {}) };
  }
  if (data.askUserQuestion) {
    if (data.askUserQuestion.cleared) return { ask: { type: 'clear' } };
    if (data.askUserQuestion.questions) {
      return { ask: { type: 'park', toolUseID: data.askUserQuestion.toolUseID!, questions: data.askUserQuestion.questions } };
    }
    return {};
  }
  if (data.toolResult) return { streamEvent: true };
  if (data.error) return { streamEvent: true, error: data.error };
  return {};
}

/**
 * The Stream panel's event list after a session-stream payload. Consecutive text
 * chunks coalesce into one text event. Returns `prev` itself when the payload
 * adds nothing.
 */
export function appendStreamEvent(prev: StreamEvent[], data: SessionStreamPayload, now: number): StreamEvent[] {
  if (data.text) {
    const last = prev[prev.length - 1];
    if (last && last.type === 'text') {
      return [...prev.slice(0, -1), { ...last, content: (last as any).content + data.text }];
    }
    return [...prev, { type: 'text' as const, content: data.text, ts: now }];
  }
  if (data.toolUse) {
    const tool = data.toolUse;
    if (tool.status === 'starting') return [...prev, { type: 'tool_start' as const, name: tool.name, ts: now }];
    if (tool.status === 'complete') return [...prev, { type: 'tool_complete' as const, name: tool.name, input: tool.input, ts: now }];
    return prev;
  }
  if (data.toolResult) return [...prev, { type: 'tool_result' as const, preview: data.toolResult.preview, ts: now } as StreamEvent];
  if (data.error) return [...prev, { type: 'error' as const, content: data.error, ts: now }];
  return prev;
}

// ----------------------------------------------------------------- session-usage

export type LiveContextMap = Record<string, { tokens: number; window: number }>;

/**
 * Live context occupancy for a session. An ABSOLUTE level (the latest call's
 * prompt size), so last value wins — no baseline, no arithmetic. The window only
 * arrives with the turn's `result`, and later events in the same turn report 0
 * until then, so keep the last known non-zero window (the fill bar mustn't blink
 * out mid-turn). Returns `prev` itself when nothing changed or the payload has
 * no token count.
 */
export function applyContextUsage(
  prev: LiveContextMap,
  sessionId: string,
  data: { contextTokens?: unknown; contextWindow?: unknown },
): LiveContextMap {
  if (typeof data.contextTokens !== 'number') return prev;
  const prior = prev[sessionId];
  const window = typeof data.contextWindow === 'number' && data.contextWindow > 0 ? data.contextWindow : (prior?.window ?? 0);
  if (prior?.tokens === data.contextTokens && prior?.window === window) return prev;
  return { ...prev, [sessionId]: { tokens: data.contextTokens, window } };
}

/**
 * Drop a session's live context overlay when its turn ends or is stopped: the
 * archive becomes the source of truth again. Left behind, the overlay outranks
 * the archive for the life of the page (it can never be superseded downward),
 * stranding a stale-high reading after a rewind.
 */
export function clearContextUsage(prev: LiveContextMap, sessionId: string): LiveContextMap {
  if (!(sessionId in prev)) return prev;
  const next = { ...prev };
  delete next[sessionId];
  return next;
}

// ---------------------------------------------------------------- session-health

export interface HealthPayload {
  isStuck?: boolean;
  stuckReason?: string;
  isProcessing?: boolean;
  backgroundActive?: boolean;
  startedAt?: number;
  liveness?: Liveness;
}

export interface HealthOutcome {
  isStuck: boolean | undefined;
  stuckReason: string | undefined;
  backgroundWorking: boolean;
  /**
   * Latch-break: the session is processing but the view isn't loading — a
   * transient false already committed this turn's partials. Re-strip on this
   * anchor (0 = no anchor) and turn loading back on. Null otherwise.
   */
  restripAt: number | null;
  /**
   * The turn truly ended: refresh the transcript and announce it. NOT while
   * background work is live (P1) — a background task posting a
   * <task-notification> drives a NEW turn moments after this idle edge, and
   * committing the on-disk partials now flashes an intermediary bubble.
   */
  turnEnded: boolean;
}

/** What a `session-health` beat means. `loading`: a main turn is in flight. */
export function reduceHealth(data: HealthPayload, { loading }: { loading: boolean }): HealthOutcome {
  return {
    isStuck: data.isStuck,
    stuckReason: data.stuckReason,
    backgroundWorking: !!data.backgroundActive,
    restripAt: data.isProcessing && !loading ? (typeof data.startedAt === 'number' ? data.startedAt : 0) : null,
    turnEnded: !data.isProcessing && !data.backgroundActive && loading,
  };
}

// --------------------------------------------------------- 15s fallback health poll

export interface HealthPollOutcome {
  /** Sync the background-work dots (undefined = leave as is). */
  backgroundWorking?: boolean;
  /** The consecutive isProcessing:false streak after this reading. */
  falseStreak: number;
  /** Tear down the in-flight view and commit the transcript RAW. */
  teardown: boolean;
  /** Log: a live reading reset a non-zero streak (the prior streak). */
  resetFromStreak?: number;
  /** Log: an isProcessing:false while loading — the inflight-partials trigger
   *  (the streak including this reading). */
  falseReadingStreak?: number;
}

/**
 * The fallback poll's reading — a safety net for a dead SSE stream, never the
 * primary signal.
 *
 * Under the liveness projection, the PULL (applied by the caller) is the poll's
 * whole job; the legacy teardown is bypassed. Otherwise: a single false is
 * untrustworthy (an HMR singleton swap can momentarily report a live SDK session
 * idle), so require TWO consecutive falses (~30s) before tearing down, and never
 * tear down while background work is live (a task-notification turn may be
 * imminent — Defect B).
 */
export function reduceHealthPoll(
  data: { isProcessing?: boolean; backgroundActive?: boolean },
  { loading, projectionOn, falseStreak }: { loading: boolean; projectionOn: boolean; falseStreak: number },
): HealthPollOutcome {
  if (projectionOn) return { falseStreak, teardown: false };
  const backgroundWorking = !!data.backgroundActive;
  if (!loading) return { backgroundWorking, falseStreak, teardown: false };
  if (data.isProcessing) {
    return { backgroundWorking, falseStreak: 0, teardown: false, ...(falseStreak > 0 ? { resetFromStreak: falseStreak } : {}) };
  }
  if (data.backgroundActive) return { backgroundWorking, falseStreak: 0, teardown: false };
  const streak = falseStreak + 1;
  if (streak < 2) return { backgroundWorking, falseStreak: streak, teardown: false, falseReadingStreak: streak };
  return { backgroundWorking, falseStreak: 0, teardown: true, falseReadingStreak: streak };
}

// ------------------------------------------------------------------ SSE connected

export interface BufferSnapshot {
  hasBuffer?: boolean;
  isActive?: boolean;
  isProcessing?: boolean;
  accumulatedText?: string;
  events?: StreamEvent[];
}

export interface ConnectedOutcome {
  /** Adopt the buffer's text + events (it has more than we do). */
  restoreStream: boolean;
  /** Processing is on but the view isn't loading: start loading. */
  startLoading: boolean;
  /** Processing finished between the initial restore and this connect: stop
   *  loading and refresh the transcript for the final response. */
  completed: boolean;
}

/**
 * On SSE connect, re-sync from the stream buffer to close the gap between the
 * initial restore and the connection. Uses isProcessing (session-level), not just
 * the buffer's isActive, to avoid false negatives during queue processing.
 */
export function reduceConnected(
  buf: BufferSnapshot,
  { streamingLength, loading }: { streamingLength: number; loading: boolean },
): ConnectedOutcome {
  const isProcessing = !!(buf.isProcessing || (buf.hasBuffer && buf.isActive));
  return {
    restoreStream: !!buf.hasBuffer && (buf.accumulatedText || '').length > streamingLength,
    startLoading: isProcessing && !loading,
    completed: !isProcessing && loading,
  };
}
