/**
 * Stats aggregation endpoint for the Stats tab.
 *
 * Reads the per-message usage_events table (joined to sessions for project /
 * title / message count), computes estimated cost from lib/pricing.ts, and
 * buckets everything by the caller's local day. The timezone is passed by the
 * client as `?tz=<IANA zone>` (from the browser) and echoed back so the client
 * computes its date-range cutoffs in the same zone; it falls back to Eastern if
 * absent or invalid. Raw timestamps are UTC.
 *
 * Returns compact per-(day, model) rows and per-session rows; the client pivots
 * these into the daily chart, calendar heatmap, donuts, KPIs, and sessions
 * grid, and applies the date-range filter itself. NOTE: this scans all
 * usage_events on every request (O(history)) and aggregates in memory — fine at
 * personal scale (per the small dataset); swap to a cached daily rollup table
 * if usage ever grows large.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { costForUsage, normalizeModelId } from '@/lib/pricing';
import { pricingAsOfDay } from '@/lib/pricingPoller';

const DEFAULT_TZ = 'America/New_York';

/** Validate an IANA timezone string; fall back to Eastern if invalid. */
function resolveTz(tz: string | null): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Build an epoch-ms -> "YYYY-MM-DD" formatter for the given local timezone. */
function dayFormatter(tz: string): (ms: number) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return (ms: number) => fmt.format(new Date(ms));
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

interface SessionAgg {
  sessionId: string;
  project: string;
  projectName: string;
  display: string;
  models: Set<string>;
  input: number; output: number; cacheWrite: number; cacheRead: number;
  cost: number;
  priced: boolean;
  messages: number;
  lastMs: number;
  /** Largest main-thread prompt this session ever assembled. */
  peakContext: number;
  /** Prompt size of the session's most recent main-thread call. */
  finalContext: number;
  /** Timestamp backing finalContext (internal; not serialized). */
  contextMs: number;
  /** Model context window; 0 = unknown (never guess a denominator). */
  contextWindow: number;
  /** Times the session was auto-summarised. The strongest bloat signal we have:
   *  it means the conversation hit the wall and detail was thrown away. */
  numCompactions: number;
}

export async function GET(req: Request) {
  try {
    const tz = resolveTz(new URL(req.url).searchParams.get('tz'));
    const localDay = dayFormatter(tz);
    const db = await getDb();
    const res = await db.execute(`
      SELECT u.session_id, u.model, u.ts, u.input, u.output,
             u.cache_write, u.cache_write_5m, u.cache_write_1h, u.cache_read,
             u.context_window, u.is_sidechain,
             s.project, s.display, s.metadata, s.message_count, s.created_at
      FROM usage_events u
      JOIN sessions s ON s.session_id = u.session_id
      -- finalContext takes the LAST main-thread row per session, so row order
      -- must be defined rather than left to the query planner. rowid is
      -- insertion order (= transcript line order), which breaks ts ties
      -- deterministically. Ties are not hypothetical: the parser writes ts ''
      -- when a JSONL entry has no timestamp, which Date.parse turns into NaN and
      -- the reader falls back to created_at — identical for every event in the
      -- session, collapsing them all to one ms.
      ORDER BY u.session_id, u.ts, u.rowid`);

    // (day|model) -> per-type token totals + cost
    const daily = new Map<string, {
      day: string; model: string;
      input: number; output: number; cacheWrite: number; cacheRead: number;
      tokens: number; cost: number;
    }>();
    const sessions = new Map<string, SessionAgg>();
    const modelCost = new Map<string, number>();
    let unpricedEvents = 0;
    let unpricedTokens = 0;

    for (const r of res.rows) {
      const rawModel = (r.model as string) || '';
      const model = rawModel ? normalizeModelId(rawModel) : 'unknown';
      const input = Number(r.input) || 0;
      const output = Number(r.output) || 0;
      const cacheWrite = Number(r.cache_write) || 0;
      const cacheRead = Number(r.cache_read) || 0;
      const tokens = input + output + cacheWrite + cacheRead;

      // Cache writes are priced by TTL (5m = 1.25x, 1h = 2x input). Rows written
      // before the split migration have cache_write (total) but 0 in both split
      // columns — attribute that legacy total to 1h (Claude Code's default TTL).
      let cw5m = Number(r.cache_write_5m) || 0;
      let cw1h = Number(r.cache_write_1h) || 0;
      if (cw5m === 0 && cw1h === 0 && cacheWrite > 0) cw1h = cacheWrite;

      const tsMs = r.ts ? Date.parse(r.ts as string) : NaN;
      const ms = Number.isFinite(tsMs) ? tsMs : Number(r.created_at) || 0;
      const day = localDay(ms);

      // Price by the rate in effect on the event's day, so past sessions keep
      // their original cost when rates change going forward.
      const { cost, priced } = costForUsage(rawModel, { input, output, cacheWrite5m: cw5m, cacheWrite1h: cw1h, cacheRead }, day);
      if (!priced) { unpricedEvents++; unpricedTokens += tokens; }

      const dk = day + '|' + model;
      const d = daily.get(dk);
      if (d) {
        d.input += input; d.output += output; d.cacheWrite += cacheWrite; d.cacheRead += cacheRead;
        d.tokens += tokens; d.cost += cost;
      } else {
        daily.set(dk, { day, model, input, output, cacheWrite, cacheRead, tokens, cost });
      }

      modelCost.set(model, (modelCost.get(model) || 0) + cost);

      const sid = r.session_id as string;
      let s = sessions.get(sid);
      if (!s) {
        // Prefer the user-set session label (metadata.label) over the
        // first-prompt snippet, matching the chat sidebar. numCompactions comes
        // from the same blob — parse once and reuse.
        let label: string | undefined;
        let numCompactions = 0;
        if (r.metadata) {
          try {
            const m = JSON.parse(r.metadata as string);
            label = m?.label || undefined;
            numCompactions = Number(m?.numCompactions) || 0;
          } catch { /* ignore */ }
        }
        s = {
          sessionId: sid,
          project: (r.project as string) || '',
          projectName: basename((r.project as string) || ''),
          display: label || (r.display as string) || sid,
          models: new Set(),
          input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
          cost: 0, priced: true,
          messages: Number(r.message_count) || 0,
          lastMs: 0,
          peakContext: 0, finalContext: 0, contextMs: -1, contextWindow: 0,
          numCompactions,
        };
        sessions.set(sid, s);
      }
      s.input += input; s.output += output; s.cacheWrite += cacheWrite; s.cacheRead += cacheRead;
      s.cost += cost;
      if (!priced) s.priced = false;
      if (model !== 'unknown') s.models.add(model);
      if (ms > s.lastMs) s.lastMs = ms;

      // Context occupancy at this call = its prompt size. Already stored per
      // event, so peak/final need no new columns.
      //
      // Sidechains are EXCLUDED: a subagent runs its own fresh (much smaller)
      // context under a possibly different model, so counting it would dent the
      // curve and — since `final` is the latest event — could report a
      // subagent's ~3k call as the session's ending context. Its tokens still
      // count toward cost above; only the context view filters.
      if (Number(r.is_sidechain) !== 1) {
        const eventContext = input + cacheWrite + cacheRead;
        if (eventContext > s.peakContext) s.peakContext = eventContext;
        // Latest main-thread call wins — ts ties resolve to the last row read,
        // which is insertion (line) order.
        if (ms >= s.contextMs) { s.contextMs = ms; s.finalContext = eventContext; }
        const win = Number(r.context_window) || 0;
        if (win > s.contextWindow) s.contextWindow = win;
      }
    }

    // Fury's own stealth sessions (lib/stealthSessions.ts): no sessions row by
    // design, so they're absent above. Their spend still counts — into the daily
    // chart, model totals and spend KPI — and surfaces as ONE line item per
    // (consumer, local day), titled with the agent's human-readable label
    // ("Search agent") under the "Background agents" project. The underlying
    // session ids never appear. docs/ticket-stealth-sessions.md §5.
    const internalRows = await loadInternalUsageRows(db, localDay);
    for (const r of internalRows) {
      const dk = r.day + '|' + r.model;
      const d = daily.get(dk);
      if (d) {
        d.input += r.input; d.output += r.output; d.cacheWrite += r.cacheWrite; d.cacheRead += r.cacheRead;
        d.tokens += r.tokens; d.cost += r.cost;
      } else {
        daily.set(dk, { day: r.day, model: r.model, input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead, tokens: r.tokens, cost: r.cost });
      }
      modelCost.set(r.model, (modelCost.get(r.model) || 0) + r.cost);
      if (!r.priced) { unpricedEvents++; unpricedTokens += r.tokens; }
    }

    // Stable model ordering by total cost desc → fixed color slots on the client.
    const models = [...modelCost.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);

    const sessionRows = [...sessions.values()].map(s => ({
      sessionId: s.sessionId,
      project: s.project,
      projectName: s.projectName,
      display: s.display,
      models: [...s.models],
      input: s.input, output: s.output, cacheWrite: s.cacheWrite, cacheRead: s.cacheRead,
      tokens: s.input + s.output + s.cacheWrite + s.cacheRead,
      cost: s.cost,
      priced: s.priced,
      messages: s.messages,
      day: localDay(s.lastMs),
      lastMs: s.lastMs,
      // Context view (main thread only — see the aggregation above).
      peakContext: s.peakContext,
      finalContext: s.finalContext,
      // 0 = unknown denominator (session predates window capture) — the client
      // renders the size but no fill %, rather than guessing.
      contextWindow: s.contextWindow,
      peakFill: s.contextWindow > 0 ? s.peakContext / s.contextWindow : 0,
      numCompactions: s.numCompactions,
      // Normalized efficiency. Raw cost/tokens only ever surface the LONGEST
      // sessions — "I did a lot of work" — which is not the same question as
      // "was that work efficient". Per-message divides that out, so a 20-message
      // session that cost $12 outranks a 300-message one that cost $15.
      // Serialized (not derived on the client) so the table can sort on it like
      // any other column. messages can be 0 for a session whose history entry
      // never landed; 0 sorts to the bottom rather than dividing by zero.
      costPerMsg: s.messages > 0 ? s.cost / s.messages : 0,
      tokensPerMsg: s.messages > 0
        ? (s.input + s.output + s.cacheWrite + s.cacheRead) / s.messages
        : 0,
    }));
    sessionRows.push(...rollUpInternal(internalRows, localDay));
    sessionRows.sort((a, b) => b.lastMs - a.lastMs);

    return NextResponse.json({
      timezone: tz,
      pricingAsOf: await pricingAsOfDay(),
      generatedAt: Date.now(),
      today: localDay(Date.now()),
      models,
      daily: [...daily.values()],
      sessions: sessionRows,
      unpriced: { events: unpricedEvents, tokens: unpricedTokens },
    });
  } catch (err) {
    console.error('[Stats API] error:', err);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}

/** Project column for stealth-consumer spend rows. */
const INTERNAL_PROJECT_NAME = 'Background agents';
/** Reserved sessionId namespace for those roll-up rows (never a real session). */
const INTERNAL_ID_PREFIX = 'fury-internal:';

interface InternalUsageRow {
  consumer: string; label: string | null; model: string; day: string; ms: number;
  input: number; output: number; cacheWrite: number; cacheRead: number;
  tokens: number; cost: number; priced: boolean;
}

async function loadInternalUsageRows(
  db: Awaited<ReturnType<typeof getDb>>,
  localDay: (ms: number) => string,
): Promise<InternalUsageRow[]> {
  let res;
  try {
    res = await db.execute(`
      SELECT consumer, label, model, ts, input, output, cache_write_5m, cache_write_1h, cache_read
      FROM internal_usage ORDER BY ts`);
  } catch {
    return []; // table missing on a DB that hasn't run the v4 migration yet
  }
  const out: InternalUsageRow[] = [];
  for (const r of res.rows) {
    // The registry always writes an ISO ts. A row without a parseable one
    // can't be placed on a day; defaulting to 0 would draw a phantom bar at
    // the epoch (1969-12-31 west of UTC), so it's skipped instead.
    const ms = Date.parse((r.ts as string) || '');
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const rawModel = (r.model as string) || '';
    const input = Number(r.input) || 0;
    const output = Number(r.output) || 0;
    const cw5m = Number(r.cache_write_5m) || 0;
    const cw1h = Number(r.cache_write_1h) || 0;
    const cacheRead = Number(r.cache_read) || 0;
    const day = localDay(ms);
    const { cost, priced } = costForUsage(rawModel, { input, output, cacheWrite5m: cw5m, cacheWrite1h: cw1h, cacheRead }, day);
    out.push({
      consumer: String(r.consumer), label: (r.label as string) || null, model: rawModel ? normalizeModelId(rawModel) : 'unknown', day, ms,
      input, output, cacheWrite: cw5m + cw1h, cacheRead,
      tokens: input + output + cw5m + cw1h + cacheRead, cost, priced,
    });
  }
  return out;
}

/**
 * One session-shaped row per (consumer, day). Shaped like a real row so the
 * sessions grid, sorting and date filtering need no special path; `internal`
 * plus an empty `project` make it non-navigable (the grid only opens rows with
 * a project). Context fields are zero: there is no user-facing context to show.
 */
function rollUpInternal(rows: InternalUsageRow[], localDay: (ms: number) => string) {
  const groups = new Map<string, {
    consumer: string; label: string | null; labelMs: number; day: string; models: Set<string>;
    input: number; output: number; cacheWrite: number; cacheRead: number;
    cost: number; priced: boolean; calls: number; lastMs: number;
  }>();
  for (const r of rows) {
    const key = r.consumer + '|' + r.day;
    let g = groups.get(key);
    if (!g) {
      g = { consumer: r.consumer, label: null, labelMs: -1, day: r.day, models: new Set(), input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, priced: true, calls: 0, lastMs: 0 };
      groups.set(key, g);
    }
    // The most recent label wins, so renaming an agent relabels its history.
    if (r.label && r.ms >= g.labelMs) { g.label = r.label; g.labelMs = r.ms; }
    if (r.model !== 'unknown') g.models.add(r.model);
    g.input += r.input; g.output += r.output; g.cacheWrite += r.cacheWrite; g.cacheRead += r.cacheRead;
    g.cost += r.cost; if (!r.priced) g.priced = false;
    g.calls++; if (r.ms > g.lastMs) g.lastMs = r.ms;
  }
  // Latest label per consumer across ALL days, so one agent reads the same on
  // every row even if an older day's rows predate a rename (or the label column).
  const latestLabel = new Map<string, { label: string; ms: number }>();
  for (const g of groups.values()) {
    const cur = latestLabel.get(g.consumer);
    if (g.label && (!cur || g.labelMs >= cur.ms)) latestLabel.set(g.consumer, { label: g.label, ms: g.labelMs });
  }
  const humanize = (name: string) => {
    const w = name.replace(/-+/g, ' ').trim();
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  return [...groups.values()].map((g) => {
    const tokens = g.input + g.output + g.cacheWrite + g.cacheRead;
    return {
      sessionId: `${INTERNAL_ID_PREFIX}${g.consumer}:${g.day}`,
      project: '',
      projectName: INTERNAL_PROJECT_NAME,
      display: latestLabel.get(g.consumer)?.label ?? humanize(g.consumer),
      models: [...g.models],
      input: g.input, output: g.output, cacheWrite: g.cacheWrite, cacheRead: g.cacheRead,
      tokens, cost: g.cost, priced: g.priced,
      // API calls, not chat messages — the closest honest analogue.
      messages: g.calls,
      day: localDay(g.lastMs),
      lastMs: g.lastMs,
      peakContext: 0, finalContext: 0, contextWindow: 0, peakFill: 0, numCompactions: 0,
      costPerMsg: g.calls > 0 ? g.cost / g.calls : 0,
      tokensPerMsg: g.calls > 0 ? tokens / g.calls : 0,
      internal: true as const,
    };
  });
}
