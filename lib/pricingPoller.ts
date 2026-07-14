/**
 * Pricing poller — keeps the Stats tab's cost estimates current by periodically
 * fetching Anthropic's published pricing page and recording what it finds.
 *
 * Design (mirrors lib/providerSwitch's durable-timer pattern):
 *   - Every attempt (ok or failed) is written to the `pricing_checks` table.
 *   - On boot, `rehydratePricingPoller()` reads the last check and schedules the
 *     next run at lastCheck + interval — so a restart never resets the cadence.
 *     If overdue (server was off longer than the interval), it runs shortly
 *     after boot.
 *   - Cadence is configurable via settings (`pricingPollIntervalDays`, default 7)
 *     and re-read on every (re)schedule.
 *   - A discovered rate change is applied FORWARD-ONLY: it's stored as a dated
 *     period in `pricing_overrides` (effective today), merged on top of the code
 *     constant. Events before today keep their old rate. The git-versioned
 *     constant remains the reviewed source of truth; a human reconciles overrides
 *     into lib/pricing.ts at leisure.
 *
 * The pricing page (https://platform.claude.com/docs/en/about-claude/pricing.md)
 * is a stable markdown table: `Model | Base Input | 5m Cache Writes | 1h Cache
 * Writes | Cache Hits & Refreshes | Output`.
 */

import type { Client } from '@libsql/client';
import { getDb } from './db';
import { settingsPersistence } from './settingsPersistence';
import { PRICING, setPricingOverrides, latestRate, type ModelRates, type RatePeriod } from './pricing';

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const TZ = 'America/New_York';
const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 15_000;
const MIN_DELAY_MS = 5_000; // don't run instantly at boot; let startup settle
const STATE_KEY = '__fury_pricing_poller__';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const etDay = (ms: number) => dayFmt.format(new Date(ms));

interface PollerState { timer: ReturnType<typeof setTimeout> | null }
function state(): PollerState {
  const g = globalThis as any;
  return (g[STATE_KEY] ??= { timer: null });
}

// ---- pricing-page parsing ----

/** "$5 / MTok" | "$0.50 / MTok" -> number, or null. */
function parseUsd(cell: string): number | null {
  const m = cell.replace(/,/g, '').match(/\$\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

/** "Claude Opus 4.8" / "Claude Sonnet 5 [through …](…)" -> canonical id, or null. */
function modelNameToId(name: string): string | null {
  const n = name
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // unwrap markdown links, keep text
    .replace(/\([^)]*\)/g, ' ')              // drop parentheticals
    .toLowerCase();
  const m = n.match(/claude\s+(fable|mythos|opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return `claude-${m[1]}-${m[2].replace('.', '-')}`;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
function sameRates(a: ModelRates, b: ModelRates): boolean {
  return r3(a.input) === r3(b.input) && r3(a.output) === r3(b.output) &&
    r3(a.cacheWrite5m) === r3(b.cacheWrite5m) && r3(a.cacheWrite1h) === r3(b.cacheWrite1h) &&
    r3(a.cacheRead) === r3(b.cacheRead);
}

/**
 * Parse the "Model pricing" table. Only rows that map to a model we already
 * track (a PRICING key) are kept. If two rows map to the same id with different
 * rates (e.g. Sonnet 5's intro vs standard rows), that id is flagged ambiguous
 * and skipped rather than guessed.
 */
export function parsePricingMarkdown(md: string): { rates: Map<string, ModelRates>; ambiguous: string[] } {
  const collected = new Map<string, ModelRates[]>();
  let inTable = false;
  for (const line of md.split('\n')) {
    if (line.includes('Base Input Tokens') && line.includes('Output Tokens')) { inTable = true; continue; }
    if (!inTable) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) break; // table ended
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // header separator row
    const cols = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cols.length < 6) continue;
    const id = modelNameToId(cols[0]);
    if (!id || !(id in PRICING)) continue; // only models we track
    const nums = [cols[1], cols[2], cols[3], cols[4], cols[5]].map(parseUsd);
    if (nums.some(v => v == null)) continue;
    const [input, cacheWrite5m, cacheWrite1h, cacheRead, output] = nums as number[];
    (collected.get(id) ?? collected.set(id, []).get(id)!).push({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });
  }
  const rates = new Map<string, ModelRates>();
  const ambiguous: string[] = [];
  for (const [id, arr] of collected) {
    if (arr.every(x => sameRates(x, arr[0]))) rates.set(id, arr[0]);
    else ambiguous.push(id);
  }
  return { rates, ambiguous };
}

// ---- override loading ----

/** Load pricing_overrides into lib/pricing (call at boot and after each poll). */
export async function loadPricingOverrides(dbArg?: Client): Promise<void> {
  const db = dbArg ?? await getDb();
  const rows = await db.execute(
    `SELECT model, effective_from, input, output, cache_write_5m, cache_write_1h, cache_read
     FROM pricing_overrides ORDER BY effective_from ASC`,
  );
  const map: Record<string, RatePeriod[]> = {};
  for (const r of rows.rows) {
    (map[r.model as string] ??= []).push({
      effectiveFrom: r.effective_from as string,
      input: Number(r.input), output: Number(r.output),
      cacheWrite5m: Number(r.cache_write_5m), cacheWrite1h: Number(r.cache_write_1h),
      cacheRead: Number(r.cache_read),
    });
  }
  setPricingOverrides(map);
}

// ---- the check ----

export interface CheckResult { status: 'ok' | 'failed'; models: number; changes: number; note: string }

export async function runPricingCheck(trigger: string): Promise<CheckResult> {
  const db = await getDb();
  let status: 'ok' | 'failed' = 'ok';
  let httpStatus = 0;
  let models = 0;
  let changes = 0;
  let note = '';

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let md: string;
    try {
      const res = await fetch(PRICING_URL, { signal: ctrl.signal, headers: { 'user-agent': 'Fury/pricing-poller' } });
      httpStatus = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      md = await res.text();
    } finally {
      clearTimeout(to);
    }

    const { rates, ambiguous } = parsePricingMarkdown(md);
    models = rates.size;
    if (models === 0) throw new Error('parsed 0 known models (page format may have changed)');

    const today = etDay(Date.now());
    const applied: string[] = [];
    for (const [id, r] of rates) {
      const cur = latestRate(id);
      if (cur && sameRates(cur, r)) continue; // unchanged
      await db.execute({
        sql: `INSERT OR IGNORE INTO pricing_overrides
                (model, effective_from, input, output, cache_write_5m, cache_write_1h, cache_read, discovered_at, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, today, r.input, r.output, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, Date.now(), 'pricing-poller'],
      });
      applied.push(`${id} $${r.input}/$${r.output}`);
    }
    changes = applied.length;
    if (changes > 0) await loadPricingOverrides(db);
    note = [
      applied.length ? `applied: ${applied.join('; ')}` : 'no changes',
      ambiguous.length ? `ambiguous(skipped): ${ambiguous.join(',')}` : '',
    ].filter(Boolean).join(' · ');
  } catch (e: any) {
    status = 'failed';
    note = String(e?.message || e).slice(0, 300);
  }

  await db.execute({
    sql: `INSERT INTO pricing_checks (checked_at, status, http_status, trigger, models_seen, changes, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [Date.now(), status, httpStatus || null, trigger, models, changes, note || null],
  });
  const level = status === 'ok' ? 'log' : 'warn';
  console[level](`[PricingPoller] ${trigger} check: ${status}, ${models} models, ${changes} change(s). ${note}`);
  return { status, models, changes, note };
}

// ---- scheduler ----

/**
 * (Re)schedule the next check. Calibrates from the last recorded check so a
 * restart continues the existing cadence instead of resetting it. Re-reads the
 * interval from settings each time, so a settings change takes effect on the
 * next cycle (or restart).
 */
async function scheduleNext(): Promise<void> {
  const st = state();
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }

  const settings = await settingsPersistence.loadSettings();
  if (!settings.pricingPollEnabled) {
    console.log('[PricingPoller] disabled in settings — not scheduling.');
    return;
  }
  const intervalMs = Math.max(1, settings.pricingPollIntervalDays) * DAY_MS;

  const db = await getDb();
  const row = await db.execute('SELECT MAX(checked_at) AS m FROM pricing_checks');
  const lastAt = Number(row.rows[0]?.m) || 0;
  const nextAt = lastAt ? lastAt + intervalMs : Date.now(); // never checked → check now
  const overdue = nextAt <= Date.now();
  const delay = Math.max(MIN_DELAY_MS, nextAt - Date.now());

  st.timer = setTimeout(async () => {
    await runPricingCheck(overdue && lastAt ? 'scheduled-overdue' : 'scheduled').catch(e =>
      console.error('[PricingPoller] check error:', e));
    await scheduleNext().catch(e => console.error('[PricingPoller] reschedule error:', e));
  }, delay);

  console.log(
    `[PricingPoller] next check in ~${Math.round(delay / 1000)}s ` +
    `(interval ${settings.pricingPollIntervalDays}d, last check ${lastAt ? new Date(lastAt).toISOString() : 'never'})`,
  );
}

/**
 * Boot hook — load overrides, then schedule the next check calibrated from the
 * last recorded one. Idempotent (clears any existing timer). Call once after the
 * HTTP server is listening so failures don't block startup.
 */
export async function rehydratePricingPoller(): Promise<void> {
  try {
    const db = await getDb();
    await loadPricingOverrides(db);
    await scheduleNext();
  } catch (err) {
    console.error('[PricingPoller] rehydrate error:', err);
  }
}

/** Run a check now (manual trigger), then re-arm the schedule from it. */
export async function triggerPricingCheck(): Promise<CheckResult> {
  const result = await runPricingCheck('manual');
  await scheduleNext().catch(e => console.error('[PricingPoller] reschedule error:', e));
  return result;
}

/** Re-arm the schedule (e.g. after a settings change). */
export async function reschedulePricingPoller(): Promise<void> {
  await scheduleNext();
}
