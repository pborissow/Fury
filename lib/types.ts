export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface TranscriptMsg {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** JSONL entry uuid (user messages) — target for SDK rewindFiles. */
  uuid?: string;
}

export interface SessionMetadata {
  label?: string;
  [key: string]: unknown;
}

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
  messageCount?: number;
  metadata?: SessionMetadata;
}

export interface PendingSession {
  sessionId: string;
  project: string;
  title: string;
  createdAt: number;
}

/**
 * A question the model is asking the user, awaiting an answer.
 *
 * `toolUseID` is REQUIRED by design, not an oversight. It is the SDK's own id
 * for the parked tool call (the correlation key /api/claude-sdk/answer matches
 * against), so a question without one is unanswerable. The JSONL transcript has
 * no toolUseID to give — which is exactly the point: a question replayed from
 * the transcript CANNOT be answered on the SDK path, and requiring the field
 * turns that into a compile error instead of a dialog that silently hangs.
 * See docs/ask-user-question-sdk.md §8 / TRAP #4.
 */
export interface AskUserQuestionState {
  /** The SDK's id for the parked tool call, or null on the CLI path, where no
   *  tool call is held open and the answer is re-sent as a fresh prose turn. */
  toolUseID: string | null;
  input: {
    questions: {
      question: string;
      header?: string;
      multiSelect: boolean;
      options: { label: string; description?: string }[];
    }[];
  };
}
