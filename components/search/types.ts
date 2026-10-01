/** Shared types & constants for the Search tab (components/search/). */

/** Persisted view preferences (lib/uiStatePersistence.ts restores these —
 *  including the query: search is usually an interrupted train of thought). */
export interface SearchPrefs {
  query: string;
  includeArchived: boolean;
  role: 'all' | 'user' | 'assistant';
  sort: 'relevance' | 'recent';
}

export interface SearchHit {
  role: 'user' | 'assistant';
  turnIndex: number;
  timestamp: string;
  snippet: string;
  rank: number;
  /** Normalized relevance 1–100 (100 = best hit in the response). Absent in
   *  LIKE-fallback mode, which has no ranking signal — render nothing then. */
  score?: number;
}

export interface SearchSessionResult {
  sessionId: string;
  project: string;
  display: string;
  status: string;
  messageCount: number;
  updatedAt: number;
  titleMatch: boolean;
  hits: SearchHit[];
  hitCount: number;
}

export interface Corpus {
  sessions: number;
  archived: number;
  messages: number;
  projects: string[];
}

/** How many snippets a session card shows before the "+N more" expander. */
export const COLLAPSED_HITS = 2;
