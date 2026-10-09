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
import { runSearch } from '@/lib/searchEngine';

export const dynamic = 'force-dynamic';

// The engine itself lives in lib/searchEngine.ts, shared with the Ask-mode
// librarian's in-process MCP tools (lib/transcriptsMcpServer.ts). This route
// only parses query params and adds timing.
export async function GET(req: Request) {
  try {
    const t0 = Date.now();
    const url = new URL(req.url);
    const roleParam = url.searchParams.get('role');
    const out = await runSearch(await getDb(), {
      q: url.searchParams.get('q') || '',
      includeArchived: url.searchParams.get('archived') !== '0',
      role: roleParam === 'user' || roleParam === 'assistant' ? roleParam : null,
      project: url.searchParams.get('project') || null,
      limit: Number(url.searchParams.get('limit')) || undefined,
    });

    if (out.kind === 'corpus') {
      return NextResponse.json({
        query: '',
        results: [],
        corpus: out.corpus,
        tookMs: Date.now() - t0,
      });
    }
    return NextResponse.json({
      query: out.query,
      mode: out.mode,
      results: out.results,
      totalHits: out.totalHits,
      sessionCount: out.sessionCount,
      tookMs: Date.now() - t0,
    });
  } catch (error) {
    console.error('[Search API] Error:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
