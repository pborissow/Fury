/**
 * The transcript-archive search engine, shared by:
 *   - GET /api/search (the Search tab), a thin HTTP wrapper, and
 *   - lib/transcriptsMcpServer.ts (the Ask-mode librarian's tools), which calls
 *     these functions in-process: no HTTP loopback, no auth, no port coupling.
 *
 * Extracted verbatim from app/api/search/route.ts (docs/ticket-ask-search.md §3).
 * Every function takes the libSQL client as a parameter rather than reaching for
 * the getDb() singleton, so tests can hand in a scratch DB and a future consumer
 * can reuse the engine without importing globals.
 *
 * READ-ONLY by construction: SELECTs only. The MCP server's "no write-capable
 * tool" rule depends on that staying true.
 */
import type { Client } from '@libsql/client';
import { buildSearchQuery, buildLikeSnippet, RENDERED_BUBBLES_FILTER } from './searchQuery';

/** Hard caps — the corpus is small, but never trust a query param. */
export const MAX_TOTAL_HITS = 200;
export const MAX_HITS_PER_SESSION = 20;

export interface SearchHit {
  role: 'user' | 'assistant';
  turnIndex: number;
  timestamp: string;
  /** Prose with MARK_OPEN/MARK_CLOSE around matched spans. */
  snippet: string;
  /** bm25 — lower is better. LIKE-mode hits share a neutral 0. */
  rank: number;
  /**
   * Renderable relevance, 1–100: this hit's bm25 as a percentage of the BEST
   * hit in the whole response (100 = best match). Raw bm25 is negative,
   * corpus/length-dependent, and not comparable across queries, so it is
   * normalized per response. Absent in LIKE mode (no ranking signal).
   */
  score?: number;
}

export interface SearchSessionResult {
  sessionId: string;
  project: string;
  /** metadata.label || display — same precedence as the sidebar and Stats. */
  display: string;
  status: string;
  messageCount: number;
  updatedAt: number;
  /** The session's title/project matched (not just message bodies). */
  titleMatch: boolean;
  hits: SearchHit[];
  /** Total message hits (hits[] is capped at MAX_HITS_PER_SESSION). */
  hitCount: number;
}

export interface SearchParams {
  q: string;
  /** Default true: the DB is a superset of disk and search is the archive's payoff. */
  includeArchived?: boolean;
  role?: 'user' | 'assistant' | null;
  /** Exact project path filter. */
  project?: string | null;
  /** Clamped to [1, MAX_TOTAL_HITS]; default MAX_TOTAL_HITS. */
  limit?: number;
}

export interface Corpus {
  sessions: number;
  archived: number;
  messages: number;
  projects: string[];
}

export type SearchOutcome =
  /** Empty / whitespace-only query: corpus stats for the empty state. */
  | { kind: 'corpus'; query: ''; results: []; corpus: Corpus }
  | {
      kind: 'results';
      query: string;
      mode: 'fts' | 'like';
      results: SearchSessionResult[];
      totalHits: number;
      sessionCount: number;
    };

/** metadata.label || display (mirrors app/api/stats/route.ts). */
export function labelledDisplay(metadata: unknown, display: unknown, sessionId: string): string {
  if (metadata) {
    try {
      const m = JSON.parse(metadata as string);
      if (m?.label) return String(m.label);
    } catch { /* ignore */ }
  }
  return (display as string) || sessionId;
}

/** Clamp a caller-supplied limit exactly as the route always has. */
export function clampLimit(raw: unknown): number {
  return Math.min(Math.max(1, Number(raw) || MAX_TOTAL_HITS), MAX_TOTAL_HITS);
}

/** Distinct project paths in the archive, sorted. */
export async function listProjects(db: Client): Promise<string[]> {
  const projects = await db.execute('SELECT DISTINCT project FROM sessions ORDER BY project');
  return projects.rows.map(r => String(r.project));
}

export interface ProjectSummary {
  project: string;
  sessions: number;
  /** Most recent session updated_at (epoch ms). */
  lastActive: number;
}

/** Projects with session counts and recency, most recently active first. */
export async function listProjectSummaries(db: Client): Promise<ProjectSummary[]> {
  const res = await db.execute(
    `SELECT project, COUNT(*) AS sessions, MAX(updated_at) AS last_active
     FROM sessions GROUP BY project ORDER BY last_active DESC`,
  );
  return res.rows.map(r => ({
    project: String(r.project),
    sessions: Number(r.sessions) || 0,
    lastActive: Number(r.last_active) || 0,
  }));
}

/** Corpus stats for the Search tab's empty state. */
export async function loadCorpus(db: Client): Promise<Corpus> {
  const corpus = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM sessions)                            AS sessions,
      (SELECT COUNT(*) FROM sessions WHERE status = 'archived')  AS archived,
      (SELECT COUNT(*) FROM messages)                            AS messages
  `);
  const row = corpus.rows[0];
  return {
    sessions: Number(row.sessions) || 0,
    archived: Number(row.archived) || 0,
    messages: Number(row.messages) || 0,
    projects: await listProjects(db),
  };
}

/**
 * Two parameterized queries against the archive:
 *  1. session-level hits — title (display + metadata.label) / project via LIKE;
 *  2. message hits — `messages_fts MATCH ?` with bm25 ranking and snippet()
 *     highlighting; if FTS errors OR finds nothing, a LIKE substring scan.
 * Results grouped by session: title-hit sessions pinned, then best bm25, then
 * recency.
 */
export async function runSearch(db: Client, params: SearchParams): Promise<SearchOutcome> {
  const q = params.q || '';
  const includeArchived = params.includeArchived !== false;
  const role = params.role === 'user' || params.role === 'assistant' ? params.role : null;
  const project = params.project || null;
  const limit = clampLimit(params.limit);

  const plan = buildSearchQuery(q);
  if (!plan) {
    return { kind: 'corpus', query: '', results: [], corpus: await loadCorpus(db) };
  }

  // Shared filter tail. `args` order matters — build once per query below.
  const archivedFilter = includeArchived ? '' : " AND s.status != 'archived'";
  const projectFilter = project ? ' AND s.project = ?' : '';

  // ---- Query 1: session-level (title / label / project) hits ----
  const titleArgs: (string | number)[] = [plan.like, plan.like, plan.like];
  if (project) titleArgs.push(project);
  const titleRes = await db.execute({
    sql: `SELECT s.session_id, s.project, s.display, s.metadata, s.message_count,
                 s.updated_at, s.status
          FROM sessions s
          WHERE (s.display LIKE ? ESCAPE '\\'
                 OR s.metadata LIKE ? ESCAPE '\\'
                 OR s.project LIKE ? ESCAPE '\\')${archivedFilter}${projectFilter}
          ORDER BY s.updated_at DESC LIMIT 50`,
    args: titleArgs,
  });

  // ---- Query 2: message hits — FTS first, LIKE fallback ----
  // snippet() args: column 0, mark-open, mark-close, ellipsis, 32 tokens
  // (FTS5 caps this at 64; 32 ≈ 2-3 rendered lines of context per hit).
  let msgRows: Record<string, unknown>[] = [];
  let mode: 'fts' | 'like' = 'fts';
  const roleFilter = role ? ' AND m.role = ?' : '';
  // Restrict hits to what the Chat tab renders by default (user bubbles +
  // the final assistant segment of each run) — intermediary assistant
  // segments are collapsed in the transcript view and would otherwise
  // surface invisible text. See RENDERED_BUBBLES_FILTER's doc for the full
  // reasoning; it stays a pure predicate so intermediaries remain indexed
  // for a future "include intermediary" toggle.
  const bubbleFilter = RENDERED_BUBBLES_FILTER;
  try {
    const ftsArgs: (string | number)[] = [plan.match];
    if (role) ftsArgs.push(role);
    if (project) ftsArgs.push(project);
    ftsArgs.push(limit);
    // char(1)/char(2) === MARK_OPEN/MARK_CLOSE — SQL constants, not bound
    // params, since FTS5 aux-function args can be finicky about binding.
    const ftsRes = await db.execute({
      sql: `SELECT m.session_id, m.role, m.turn_index, m.timestamp,
                   snippet(messages_fts, 0, char(1), char(2), '…', 32) AS snip,
                   bm25(messages_fts) AS rank,
                   s.project, s.display, s.metadata, s.message_count, s.updated_at, s.status
            FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
            JOIN sessions s ON s.session_id = m.session_id
            WHERE messages_fts MATCH ?${roleFilter}${bubbleFilter}${archivedFilter}${projectFilter}
            ORDER BY rank LIMIT ?`,
      args: ftsArgs,
    });
    msgRows = ftsRes.rows as unknown as Record<string, unknown>[];
  } catch {
    msgRows = []; // FTS parse failure — fall through to LIKE
  }

  if (msgRows.length === 0) {
    // Substring fallback (measured ~1 ms over the whole corpus). Also the
    // path for queries FTS can't express (mid-token substrings, symbols).
    mode = 'like';
    const likeArgs: (string | number)[] = [plan.like];
    if (role) likeArgs.push(role);
    if (project) likeArgs.push(project);
    likeArgs.push(limit);
    const likeRes = await db.execute({
      sql: `SELECT m.session_id, m.role, m.turn_index, m.timestamp, m.content,
                   0 AS rank,
                   s.project, s.display, s.metadata, s.message_count, s.updated_at, s.status
            FROM messages m
            JOIN sessions s ON s.session_id = m.session_id
            WHERE m.content LIKE ? ESCAPE '\\'${roleFilter}${bubbleFilter}${archivedFilter}${projectFilter}
            ORDER BY s.updated_at DESC, m.turn_index LIMIT ?`,
      args: likeArgs,
    });
    msgRows = likeRes.rows.map(r => ({
      ...r,
      // radius 160 ≈ the FTS path's 32-token snippet, so both modes render
      // comparably sized excerpts.
      snip: buildLikeSnippet(String(r.content), q.trim(), 160),
    })) as unknown as Record<string, unknown>[];
  }

  // ---- Group message hits by session ----
  const bySession = new Map<string, SearchSessionResult & { bestRank: number }>();
  const ensureSession = (r: Record<string, unknown>): SearchSessionResult & { bestRank: number } => {
    const sid = String(r.session_id);
    let s = bySession.get(sid);
    if (!s) {
      s = {
        sessionId: sid,
        project: String(r.project || ''),
        display: labelledDisplay(r.metadata, r.display, sid),
        status: String(r.status || 'active'),
        messageCount: Number(r.message_count) || 0,
        updatedAt: Number(r.updated_at) || 0,
        titleMatch: false,
        hits: [],
        hitCount: 0,
        bestRank: Infinity,
      };
      bySession.set(sid, s);
    }
    return s;
  };

  // Global best bm25 (most negative) across the response — the yardstick for
  // each hit's normalized score. LIKE mode has no ranking signal (all 0), so
  // globalBest stays 0 there and no score is emitted.
  let globalBest = 0;
  for (const r of msgRows) {
    const rank = Number(r.rank) || 0;
    if (rank < globalBest) globalBest = rank;
  }

  for (const r of msgRows) {
    const s = ensureSession(r);
    s.hitCount++;
    const rank = Number(r.rank) || 0;
    if (rank < s.bestRank) s.bestRank = rank;
    if (s.hits.length < MAX_HITS_PER_SESSION) {
      s.hits.push({
        role: r.role === 'user' ? 'user' : 'assistant',
        turnIndex: Number(r.turn_index) || 0,
        timestamp: String(r.timestamp || ''),
        snippet: String(r.snip || ''),
        rank,
        // rank/globalBest: both negative → (0,1]; 100 = the response's best
        // hit. Clamped defensively (a stray non-negative rank scores 0 → 1).
        ...(globalBest < 0
          ? { score: Math.max(1, Math.min(100, Math.round((rank / globalBest) * 100))) }
          : {}),
      });
    }
  }
  for (const r of titleRes.rows as unknown as Record<string, unknown>[]) {
    ensureSession(r).titleMatch = true;
  }

  // Session order: title hits pinned, then best bm25 (lower = better), then
  // recency. Hits within a session stay bm25-ordered (FTS) / turn-ordered (LIKE).
  const results = [...bySession.values()].sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    return b.updatedAt - a.updatedAt;
  }).map(({ bestRank: _bestRank, ...rest }) => rest);

  return {
    kind: 'results',
    query: q,
    mode,
    results,
    totalHits: msgRows.length,
    sessionCount: results.length,
  };
}

// ---------------------------------------------------------------------------
// Session digest (for confirming a candidate without loading the transcript)
// ---------------------------------------------------------------------------

export interface DigestMessage {
  role: 'user' | 'assistant';
  turnIndex: number;
  timestamp: string;
  /** Truncated to the caller's maxChars, with a trailing '…' when cut. */
  text: string;
}

export interface SessionDigest {
  sessionId: string;
  /** metadata.label || display. */
  display: string;
  project: string;
  status: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** First and last N RENDERED messages (same bubble filter as search). */
  first: DigestMessage[];
  last: DigestMessage[];
}

export const DIGEST_MAX_MESSAGES = 10;
export const DIGEST_MAX_CHARS = 400;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Who/where/when for one archived session, plus the first and last `n`
 * rendered messages (truncated). Bounded on purpose: enough to judge "is this
 * the session they mean?" without pouring a whole transcript into the caller's
 * context. Null when the session doesn't exist.
 */
export async function getSessionDigest(
  db: Client,
  sessionId: string,
  opts: { n?: number; maxChars?: number } = {},
): Promise<SessionDigest | null> {
  const n = Math.min(Math.max(1, Math.floor(Number(opts.n) || 3)), DIGEST_MAX_MESSAGES);
  const maxChars = Math.min(Math.max(40, Math.floor(Number(opts.maxChars) || 240)), DIGEST_MAX_CHARS);
  const s = await db.execute({
    sql: `SELECT session_id, project, display, metadata, message_count, created_at, updated_at, status
          FROM sessions WHERE session_id = ?`,
    args: [sessionId],
  });
  const row = s.rows[0];
  if (!row) return null;

  const pick = async (order: 'ASC' | 'DESC') => {
    const res = await db.execute({
      sql: `SELECT m.role, m.turn_index, m.timestamp, m.content
            FROM messages m
            WHERE m.session_id = ?${RENDERED_BUBBLES_FILTER}
            ORDER BY m.turn_index ${order} LIMIT ?`,
      args: [sessionId, n],
    });
    return res.rows.map((r): DigestMessage => ({
      role: r.role === 'user' ? 'user' : 'assistant',
      turnIndex: Number(r.turn_index) || 0,
      timestamp: String(r.timestamp || ''),
      text: truncate(String(r.content || ''), maxChars),
    }));
  };
  const first = await pick('ASC');
  const lastDesc = await pick('DESC');
  // Don't repeat messages for short sessions: `last` only carries what `first` didn't.
  const seen = new Set(first.map((m) => m.turnIndex));
  const last = lastDesc.filter((m) => !seen.has(m.turnIndex)).reverse();

  return {
    sessionId,
    display: labelledDisplay(row.metadata, row.display, sessionId),
    project: String(row.project || ''),
    status: String(row.status || 'active'),
    messageCount: Number(row.message_count) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    first,
    last,
  };
}
