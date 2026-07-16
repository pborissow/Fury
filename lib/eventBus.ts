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
}

export interface SessionHealthEvent {
  type: 'session:health';
  sessionId: string;
  isProcessing: boolean;
  isStuck: boolean;
  stuckReason?: string;
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

export type AppEvent =
  | LiveSessionsEvent
  | HistoryUpdatedEvent
  | SessionStreamEvent
  | SessionHealthEvent
  | SessionModelEvent
  | SessionUsageEvent
  | TranscriptUpdatedEvent
  | ProviderSwitchedEvent
  | McpUpdatedEvent;

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
