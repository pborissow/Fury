import { EventEmitter } from 'events';

// ---- Event payload types ----

export interface LiveSessionsEvent {
  type: 'live-sessions';
  liveSessionIds: string[];
}

export interface HistoryUpdatedEvent {
  type: 'history-updated';
}

export interface SessionStreamEvent {
  type: 'session:stream';
  sessionId: string;
  text?: string;
  toolUse?: { name: string; status: string; input?: any };
  toolResult?: { preview: string };
  error?: string;
  /**
   * The model is parked in canUseTool awaiting an answer to AskUserQuestion.
   * Carries its OWN toolUseID: the `toolUse` event above deliberately does not
   * include one, so this is the only channel that can correlate a rendered
   * dialog back to the parked tool call that /api/claude-sdk/answer resolves.
   * `cleared` fires when the question was settled by someone else (abort,
   * another tab, teardown) so open dialogs can close themselves.
   */
  askUserQuestion?: { toolUseID: string; questions: any[] } | { cleared: true };
  /**
   * MCP servers that FAILED to connect at session `system:init` (status
   * "failed" — the server crashed/couldn't start). Emitted once per init so the
   * UI can surface "codemogger failed to connect" instead of the MCP panel's
   * config-derived healthy badge. Deliberately excludes benign non-connected
   * states (needs-auth / pending) — those are log-only, so an un-authed claude.ai
   * connector doesn't raise a false "failed" on every session. An explicit EMPTY
   * array is a CLEAR signal (a previously-failed server recovered) — the client
   * retracts its banner. The authoritative set is also on /api/stream-buffer
   * (`mcpFailed`) for restore-on-open. (B4 in the ticket.)
   */
  mcpServers?: { name: string; status: string }[];
}

/**
 * The single authoritative liveness projection for a session — "is Claude working
 * right now, and how?" (docs/design-liveness-single-source-of-truth.md).
 *
 * Exactly one function computes this (`sdkSessionManager.deriveLiveness`); PUSH
 * (`session:health` SSE) and PULL (`/api/health`) both ship the SAME object. The
 * client is meant to store this one value and render it, instead of re-deriving
 * liveness from an OR of proxies. Introduced additively — existing fields on
 * SessionHealthEvent remain until the client is migrated (design doc, step 2).
 */
export type LivenessPhase = 'idle' | 'main-turn' | 'background';

export interface Liveness {
  /** The one dot-driving fact. `idle` → no dots; anything else → dots. */
  phase: LivenessPhase;
  /** The CURRENT turn's start (ms), or null when idle. The strip anchor — null
   *  when idle so it can never point at a finished turn (review Finding 2). */
  startedAt: number | null;
  /** Main thread is emitting this session's own turn (not a subagent's). */
  mainTurnActive: boolean;
  /** A Claude subagent / monitor / workflow is running between/around the main
   *  turn. Detached `run_in_background` shells are excluded (Defect A). */
  backgroundActive: boolean;
  /** The CLI process is alive — the sidebar LIVE badge's source, kept distinct
   *  from the dots so a busy process can't imply the turn is emitting. */
  processAlive: boolean;
  /** Hung-turn watchdog (unchanged semantics from the legacy fields). */
  isStuck: boolean;
  stuckReason?: string;
  /** Monotonic per session — the client ignores any level with seq ≤ its current,
   *  so a late/duplicated beat can't move state backward. */
  seq: number;
  /** Server clock at derivation, for staleness (a missing heartbeat past ~2×
   *  interval means "reconnect", never "declare done"). */
  at: number;
}

export interface SessionHealthEvent {
  type: 'session:health';
  sessionId: string;
  isProcessing: boolean;
  isStuck: boolean;
  stuckReason?: string;
  /** The single-source-of-truth liveness projection (design doc). Additive: the
   *  legacy fields below stay until the client renders `liveness` directly. */
  liveness?: Liveness;
  /** The in-flight turn's start (ms) — the strip anchor. Present while
   *  isProcessing is true (sourced from the stream buffer, the SAME value
   *  /api/stream-buffer returns). The client's latch-break slices partials
   *  at/after it instead of falling back to the trailing-assistant heuristic,
   *  which over-strips when a mid-turn prompt was folded into a tool_result. */
  startedAt?: number;
  /** True while the session has in-flight BACKGROUND work (a dispatched subagent/
   *  Bash still running) even though its main turn is idle. The client shows the
   *  bouncing dots on `isProcessing || backgroundActive`, and the events route
   *  counts it toward the Live badge — so an orchestrator stays live across the
   *  whole background window, not just its own main turns. */
  backgroundActive?: boolean;
}

export interface SessionModelEvent {
  type: 'session:model';
  sessionId: string;
  model: string;
}

export interface SessionUsageEvent {
  type: 'session:usage';
  sessionId: string;
  /** Total billed tokens (input + output + cache write + cache read) accrued so
   *  far in the in-flight turn, summed per unique assistant message id. The
   *  client adds this to the archived baseline (metadata.totalTokens). */
  turnTokens: number;
  /** Current context occupancy in tokens — the prompt size of the latest API
   *  call (input + cache write + cache read). Unlike turnTokens this is an
   *  absolute level, not an increment: the client renders it directly and must
   *  NOT add it to a baseline. */
  contextTokens: number;
  /** The model's context window, from the SDK's result.modelUsage. 0 until the
   *  first result message of the session arrives (the window isn't known before
   *  then), in which case the client shows size without a fill %. */
  contextWindow: number;
}

export interface TranscriptUpdatedEvent {
  type: 'transcript:updated';
  sessionId: string;
  project: string;
}

export interface ProviderSwitchedEvent {
  type: 'provider:switched';
  provider: 'anthropic' | 'bedrock';
  message: string;
}

export interface McpUpdatedEvent {
  type: 'mcp:updated';
  projectPath: string | null;
}

/**
 * A TERMINAL usage/rate limit on the turn's model — the account has hit its quota
 * for that model (HTTP 429), NOT a transient overload the SDK retries and recovers
 * from. The turn produced no visible output, so without this the UI would just go
 * silent (the "are you still there?" bug). The client opens a recovery dialog that
 * offers switching to another model (and auto-resending the failed prompt) or, when
 * configured, the Bedrock fallback. Distinct from `session:stream {error}` so the UI
 * can react with an actionable dialog rather than a passive error bubble.
 */
export interface SessionLimitEvent {
  type: 'session:limit';
  sessionId: string;
  /** The model that was limited (wire id, e.g. 'claude-fable-5'). */
  limitedModel: string | null;
  /** The provider's own message, shown verbatim in the dialog. */
  message: string;
  /** HTTP status when known (429 for a usage limit). */
  status?: number;
}

export type AppEvent =
  | LiveSessionsEvent
  | HistoryUpdatedEvent
  | SessionStreamEvent
  | SessionHealthEvent
  | SessionModelEvent
  | SessionUsageEvent
  | TranscriptUpdatedEvent
  | ProviderSwitchedEvent
  | McpUpdatedEvent
  | SessionLimitEvent;

class AppEventBus extends EventEmitter {
  emitApp(payload: AppEvent): boolean {
    return super.emit('app-event', payload);
  }

  onApp(listener: (payload: AppEvent) => void): this {
    return super.on('app-event', listener);
  }

  offApp(listener: (payload: AppEvent) => void): this {
    return super.off('app-event', listener);
  }
}

// Singleton — survives Next.js hot-reload via globalThis
const globalKey = '__fury_event_bus__';
export const eventBus: AppEventBus =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new AppEventBus());

// Prevent memory leak warnings for many SSE clients
eventBus.setMaxListeners(50);
