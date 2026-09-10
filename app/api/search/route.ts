/**
 * Search endpoint for the Search tab (docs/plan-search-tab.md §3, §5 A3).
 *
 * `GET /api/search?q=…&archived=1&role=all|user|assistant&project=…&limit=…`
 *
 * Two parameterized queries against the SQLite transcript archive:
 *  1. session-level hits — title (display + metadata.label) / project via LIKE
 *     (~30 rows, trivial);
 *  2. message hits — `messages_fts MATCH ?` with bm25 ranking and snippet()
 *     highlighting, JOINed back to messages + sessions. If FTS errors OR finds
 *     nothing, a LIKE substring scan over messages runs instead (~1 ms —
 *     covers substring-ish queries FTS can't express).
 *
 * Results are grouped by session: title-hit sessions pinned above, then best
 * bm25 rank. Archived sessions are INCLUDED by default — the DB is a superset
 * of disk and search is the archive's payoff (§2.4); `archived=0` filters them.
 *
 * Snippets carry / boundary markers (MARK_OPEN/MARK_CLOSE), which
 * the client splits into <mark> — snippet text is never interpreted as HTML.
 *
 * Without `q`, returns corpus stats for the tab's empty state (session/message
 * counts + distinct projects for the filter dropdown).
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildSearchQuery, buildLikeSnippet, RENDERED_BUBBLES_FILTER } from '@/lib/searchQuery';

export const dynamic = 'force-dynamic';

/** Hard caps — the corpus is small, but never trust a query param. */
const MAX_TOTAL_HITS = 200;
const MAX_HITS_PER_SESSION = 20;

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

/** metadata.label || display (mirrors app/api/stats/route.ts). */
function labelledDisplay(metadata: unknown, display: unknown, sessionId: string): string {
  if (metadata) {
    try {
      const m = JSON.parse(metadata as string);
      if (m?.label) return String(m.label);
    } catch { /* ignore */ }
  }
  return (display as string) || sessionId;
}

export async function GET(req: Request) {
  try {
    const t0 = Date.now();
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const includeArchived = url.searchParams.get('archived') !== '0';
    const roleParam = url.searchParams.get('role');
    const role = roleParam === 'user' || roleParam === 'assistant' ? roleParam : null;
    const project = url.searchParams.get('project') || null;
    const limit = Math.min(
      Math.max(1, Number(url.searchParams.get('limit')) || MAX_TOTAL_HITS),
      MAX_TOTAL_HITS,
    );

    const db = await getDb();

    const plan = buildSearchQuery(q);
    if (!plan) {
      // Empty-state corpus stats.
      const corpus = await db.execute(`
        SELECT
          (SELECT COUNT(*) FROM sessions)                            AS sessions,
          (SELECT COUNT(*) FROM sessions WHERE status = 'archived')  AS archived,
          (SELECT COUNT(*) FROM messages)                            AS messages
      `);
      const projects = await db.execute(
        'SELECT DISTINCT project FROM sessions ORDER BY project',
      );
      const row = corpus.rows[0];
      return NextResponse.json({
        query: '',
        results: [],
        corpus: {
          sessions: Number(row.sessions) || 0,
          archived: Number(row.archived) || 0,
          messages: Number(row.messages) || 0,
          projects: projects.rows.map(r => String(r.project)),
        },
        tookMs: Date.now() - t0,
      });
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

    return NextResponse.json({
      query: q,
      mode,
      results,
      totalHits: msgRows.length,
      sessionCount: results.length,
      tookMs: Date.now() - t0,
    });
  } catch (error) {
    console.error('[Search API] Error:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
