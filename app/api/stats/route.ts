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
import { costForUsage, normalizeModelId, PRICING_AS_OF } from '@/lib/pricing';

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
}

export async function GET(req: Request) {
  try {
    const tz = resolveTz(new URL(req.url).searchParams.get('tz'));
    const localDay = dayFormatter(tz);
    const db = await getDb();
    const res = await db.execute(`
      SELECT u.session_id, u.model, u.ts, u.input, u.output,
             u.cache_write, u.cache_write_5m, u.cache_write_1h, u.cache_read,
             s.project, s.display, s.metadata, s.message_count, s.created_at
      FROM usage_events u
      JOIN sessions s ON s.session_id = u.session_id`);

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
        // first-prompt snippet, matching the chat sidebar.
        let label: string | undefined;
        if (r.metadata) {
          try { label = JSON.parse(r.metadata as string)?.label || undefined; } catch { /* ignore */ }
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
        };
        sessions.set(sid, s);
      }
      s.input += input; s.output += output; s.cacheWrite += cacheWrite; s.cacheRead += cacheRead;
      s.cost += cost;
      if (!priced) s.priced = false;
      if (model !== 'unknown') s.models.add(model);
      if (ms > s.lastMs) s.lastMs = ms;
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
    })).sort((a, b) => b.lastMs - a.lastMs);

    return NextResponse.json({
      timezone: tz,
      pricingAsOf: PRICING_AS_OF,
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
