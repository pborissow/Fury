export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface TranscriptMsg {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
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

export interface AskUserQuestionState {
  input: {
    questions: {
      question: string;
      header?: string;
      multiSelect: boolean;
      options: { label: string; description?: string }[];
    }[];
  };
}
