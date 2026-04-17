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
}

export interface SessionHealthEvent {
  type: 'session:health';
  sessionId: string;
  isProcessing: boolean;
  isStuck: boolean;
  stuckReason?: string;
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
