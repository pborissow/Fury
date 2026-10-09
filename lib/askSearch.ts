/**
 * Ask-mode search: the "Search agent" consumer of stealth sessions
 * (docs/ticket-ask-search.md §4; infra in docs/ticket-stealth-sessions.md).
 *
 *   const out = await askSearch('where did we work on the file tree in fury?', { signal, onToolEvent });
 *   // → { summary, results: [{ sessionId, turnIndex, why, title, project, ... }], dropped, ... }
 *
 * Pieces:
 *   - the agent: .claude/agents/transcript-searcher.md (Haiku, three tools only)
 *   - its tools: lib/transcriptsMcpServer.ts, a fresh in-process instance per spawn
 *   - its answer: schema-enforced structured output (ANSWER_SCHEMA), validated by
 *     the CLI with model retries, instead of a fenced JSON block parsed from prose
 *   - resolveAnswer(): the ticket's "hallucinated sessionId → dropped" rule. Every
 *     id is checked against the archive; an unknown session is dropped, an unknown
 *     turn on a real session keeps the session but loses the deep-link turn.
 */
import type { Client } from '@libsql/client';
import { getDb } from './db';
import { labelledDisplay, listProjects, runSearch, type SearchSessionResult } from './searchEngine';
import { questionResidue } from './askIntent';
import { stealthSessions, type AskOptions, type StealthConfig } from './stealthSessions';
import { transcriptsMcpServer, TRANSCRIPTS_MCP_SERVER_NAME } from './transcriptsMcpServer';

export const ASK_SEARCH_NAME = 'ask-search';
export const ASK_SEARCH_LABEL = 'Search agent';
export const MAX_RESULTS = 8;
export { MAX_QUESTION_CHARS } from './askIntent';
import { MAX_QUESTION_CHARS } from './askIntent';
/** Per-question budget (ticket §6: ~30 s). */
export const ASK_TIMEOUT_MS = 30_000;

/**
 * The answer contract. Kept deliberately small: the UI rebuilds cards from the
 * archive (resolveAnswer), so the model only supplies ids, a pointer and a reason.
 */
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'results'],
  properties: {
    summary: { type: 'string', description: 'One line: what was found (or that nothing was).' },
    results: {
      type: 'array',
      maxItems: MAX_RESULTS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'why'],
        properties: {
          sessionId: { type: 'string', description: 'Copied verbatim from a tool result.' },
          turnIndex: { type: 'integer', minimum: 0, description: 'Most relevant message, copied verbatim from a hit. Omit if unsure.' },
          why: { type: 'string', description: 'One short line citing the evidence.' },
        },
      },
    },
  },
} as const;

export interface RawAnswer {
  summary: string;
  results: { sessionId: string; turnIndex?: number; why: string }[];
}

export interface ResolvedResult {
  sessionId: string;
  /** Null when the model gave none, or gave one that doesn't exist in the session. */
  turnIndex: number | null;
  /** The cited message (when turnIndex resolved), for the card's hit row. */
  hit: { role: 'user' | 'assistant'; timestamp: string; excerpt: string } | null;
  why: string;
  /** From the archive, not the model. */
  title: string;
  project: string;
  status: string;
  updatedAt: number;
  messageCount: number;
}

export interface ResolvedAnswer {
  summary: string;
  results: ResolvedResult[];
  /** Results discarded because their sessionId isn't in the archive. */
  dropped: number;
}

/**
 * A card-sized plain-text excerpt of a message: markdown markup stripped
 * (cards aren't a markdown renderer), whitespace collapsed, ~280 chars.
 */
export function excerptOf(content: string, max = 280): string {
  const t = content
    .replace(/```[a-z0-9_-]*\n?/gi, '')            // code fences
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')            // headings
    .replace(/^\s*[-*+]\s+/gm, '')                 // bullets
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2') // bold
    .replace(/`([^`]+)`/g, '$1')                    // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')        // links → text
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** The stealth-session config for the Search agent. */
export function askSearchConfig(dbAccessor: () => Promise<Client> = getDb): StealthConfig {
  return {
    name: ASK_SEARCH_NAME,
    label: ASK_SEARCH_LABEL,
    model: 'haiku',
    agent: 'transcript-searcher',
    mcpServers: () => ({ [TRANSCRIPTS_MCP_SERVER_NAME]: transcriptsMcpServer(dbAccessor) }),
    outputFormat: { type: 'json_schema', schema: ANSWER_SCHEMA as unknown as Record<string, unknown> },
    // Continuity within a burst of questions (follow-ups work); bounded overall.
    recycle: { maxTurns: 20, maxContextTokens: 50_000 },
    idleKillMs: 10 * 60_000,
    askTimeoutMs: ASK_TIMEOUT_MS,
  };
}

/**
 * Shape-check structured output defensively. The CLI already validated it
 * against ANSWER_SCHEMA, but this is the trust boundary into the UI.
 */
export function normalizeAnswer(raw: unknown): RawAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.summary !== 'string' || !Array.isArray(r.results)) return null;
  const seen = new Set<string>();
  const results: RawAnswer['results'] = [];
  for (const item of r.results) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const sessionId = typeof it.sessionId === 'string' ? it.sessionId.trim() : '';
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const turn = typeof it.turnIndex === 'number' && Number.isInteger(it.turnIndex) && it.turnIndex >= 0
      ? it.turnIndex : undefined;
    results.push({ sessionId, ...(turn !== undefined ? { turnIndex: turn } : {}), why: typeof it.why === 'string' ? it.why.trim() : '' });
    if (results.length >= MAX_RESULTS) break;
  }
  return { summary: r.summary.trim(), results };
}

/** Check every id against the archive; attach title/project from the DB. */
export async function resolveAnswer(db: Client, answer: RawAnswer): Promise<ResolvedAnswer> {
  const results: ResolvedResult[] = [];
  let dropped = 0;
  for (const r of answer.results) {
    const row = (await db.execute({
      sql: `SELECT session_id, project, display, metadata, status, updated_at, message_count
            FROM sessions WHERE session_id = ?`,
      args: [r.sessionId],
    })).rows[0];
    if (!row) { dropped++; continue; }
    let turnIndex: number | null = null;
    let hit: ResolvedResult['hit'] = null;
    if (r.turnIndex !== undefined) {
      const m = (await db.execute({
        sql: 'SELECT role, timestamp, content FROM messages WHERE session_id = ? AND turn_index = ? LIMIT 1',
        args: [r.sessionId, r.turnIndex],
      })).rows[0];
      if (m) {
        turnIndex = r.turnIndex;
        hit = { role: m.role === 'user' ? 'user' : 'assistant', timestamp: String(m.timestamp || ''), excerpt: excerptOf(String(m.content || '')) };
      }
    }
    results.push({
      sessionId: r.sessionId,
      turnIndex,
      hit,
      why: r.why,
      title: labelledDisplay(row.metadata, row.display, r.sessionId),
      project: String(row.project || ''),
      status: String(row.status || 'active'),
      updatedAt: Number(row.updated_at) || 0,
      messageCount: Number(row.message_count) || 0,
    });
  }
  return { summary: answer.summary, results, dropped };
}

export interface AskSearchOutcome extends ResolvedAnswer {
  costUsd: number;
  durationMs: number;
}

/**
 * Ask the Search agent one question (follow-ups continue the same warm
 * session). Throws StealthAskError on timeout/abort/failure, and a plain Error
 * when the agent's output doesn't match the contract; the caller owns the
 * fallbacks (ticket §5/§6).
 */
export async function askSearch(
  question: string,
  opts: Pick<AskOptions, 'signal' | 'onToolEvent' | 'timeoutMs'> & { now?: Date; db?: () => Promise<Client> } = {},
): Promise<AskSearchOutcome> {
  const q = question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) throw new Error('Question is empty');
  const dbAccessor = opts.db ?? getDb;
  const session = await stealthSessions.acquire(askSearchConfig(dbAccessor));
  // The agent has no clock; give it today's date so "last week" means something.
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const r = await session.ask(`(Today is ${today}.)\n\n${q}`, {
    signal: opts.signal, onToolEvent: opts.onToolEvent, timeoutMs: opts.timeoutMs,
  });
  const answer = normalizeAnswer(r.structured);
  if (!answer) throw new Error('Search agent returned no structured answer');
  const resolved = await resolveAnswer(await dbAccessor(), answer);
  return { ...resolved, costUsd: r.costUsd, durationMs: r.durationMs };
}

// ---------------------------------------------------------------------------
// Streaming protocol for POST /api/search/ask (NDJSON, one event per line)
// ---------------------------------------------------------------------------

export type AskEvent =
  /** The agent called a tool (input trimmed to what a progress line needs). */
  | { type: 'progress'; tool: 'search_transcripts' | 'list_projects' | 'get_session' | string; input: { q?: string; project?: string; sessionId?: string } }
  | ({ type: 'answer' } & AskSearchOutcome)
  /** The agent answered, but not in the schema: show its prose. */
  | { type: 'prose'; text: string }
  /** The agent was unavailable/failed: plain keyword results on the question's residue. */
  | { type: 'fallback'; reason: string; message: string; query: string; project: string | null; results: SearchSessionResult[]; totalHits: number }
  | { type: 'error'; message: string };

/**
 * Ticket §5/§6 fallback: when the agent can't answer, strip the question to
 * its keyword core and run the ordinary engine. If the full residue finds
 * nothing (FTS ANDs every term), retry with fewer terms, longest words first.
 */
export async function keywordFallback(db: Client, question: string): Promise<{
  query: string; project: string | null; results: SearchSessionResult[]; totalHits: number;
}> {
  const { terms, project } = questionResidue(question, await listProjects(db));
  const attempts: string[][] = [terms];
  const byLength = [...terms].sort((a, b) => b.length - a.length);
  for (let n = Math.min(terms.length - 1, 2); n >= 1; n--) attempts.push(byLength.slice(0, n));
  let last = { query: terms.join(' '), project, results: [] as SearchSessionResult[], totalHits: 0 };
  for (const t of attempts) {
    if (!t.length) continue;
    const out = await runSearch(db, { q: t.join(' '), project });
    if (out.kind !== 'results') continue;
    last = { query: t.join(' '), project, results: out.results.slice(0, 20), totalHits: out.totalHits };
    if (out.results.length) break;
  }
  return last;
}
