'use client';

/**
 * Stats tab — usage, cost, and CONTEXT-EFFICIENCY analytics over all archived
 * sessions.
 *
 * The tab answers two different questions and is laid out in that order:
 *   1. "What did I spend?"  — volume: KPIs, daily bars, calendar, donuts.
 *   2. "Was it efficient?"  — pressure: which sessions bloated, and how badly.
 * (2) is the reason the tab exists: a session that carries a 600k context costs
 * ~6x per message what the same work costs at 100k, and the only cure is to
 * notice and start a new one. Volume alone can't show that — the biggest spender
 * is usually just the longest session, which is "I did a lot of work", not a
 * problem. Everything normalized (per-message, per-fill) exists to divide length
 * back out so genuine inefficiency surfaces instead.
 *
 * Data comes from /api/stats (per-(day, model) rows + per-session rows, already
 * cost-priced and bucketed to the caller's local day — we pass the browser's
 * IANA timezone to the API and reuse the zone it echoes back). All aggregation for the
 * widgets and the date-range filter happens here on the client so the
 * tokens⇄$ toggle and range presets are instant with no refetch.
 *
 * Charts use Apache ECharts. Series colors come from a CVD-validated
 * categorical palette (the app's shadcn --chart tokens fail colorblind
 * separation in light mode); all chrome/ink uses the app's semantic theme
 * colors so it reads native. Colors are keyed to the model/project entity
 * (stable order from the API), never to rank-within-filter, so filtering never
 * repaints survivors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { RefreshCw, TriangleAlert, ShieldAlert, AlertTriangle } from 'lucide-react';
import { formatTokens } from './AnimatedTokenCount';
import PricingDialog from './PricingDialog';

// ---- types (mirror /api/stats) ----
interface DailyRow {
  day: string; model: string;
  input: number; output: number; cacheWrite: number; cacheRead: number;
  tokens: number; cost: number;
}
interface SessionRow {
  sessionId: string; project: string; projectName: string; display: string;
  models: string[]; input: number; output: number; cacheWrite: number; cacheRead: number;
  tokens: number; cost: number; priced: boolean; messages: number; day: string; lastMs: number;
  /** Context view — main thread only (the API excludes sidechains). */
  peakContext: number; finalContext: number;
  /** 0 = unknown denominator; render size but never a guessed fill %. */
  contextWindow: number; peakFill: number;
  numCompactions: number;
  costPerMsg: number; tokensPerMsg: number;
}
interface StatsData {
  timezone: string; pricingAsOf: string; generatedAt: number; today: string;
  models: string[]; daily: DailyRow[]; sessions: SessionRow[];
  unpriced: { events: number; tokens: number };
}

type Measure = 'cost' | 'tokens';
type Range = 'all' | 'mtd' | '7d' | '30d' | '90d';

/** Context fill at which a session is "running hot" — calibrated on 173 real
 *  sessions (median fill 28%; only 13% ever exceed 70%), the same breakpoint the
 *  chat sidebar uses. Kept in sync deliberately: two different answers to "is
 *  this session in trouble?" across two views would be worse than either. */
const HOT_FILL = 0.7;

// ---- theme (resolved from globals.css oklch tokens → hex for ECharts) ----
// Categorical hues = dataviz validated reference palette (both modes selected).
//
// `cat` SLOT ORDER IS LOAD-BEARING, not cosmetic: it's the CVD-safety mechanism,
// derived by maximizing the minimum adjacent ΔE. This is the palette's July-2026
// order; the previous one (blue, aqua, yellow, green, violet, red, magenta,
// orange) FAILED the normal-vision floor in both modes against our own surfaces —
// light worst-adjacent orange↔magenta ΔE 12.9, dark worst-adjacent
// magenta↔red ΔE 7.8, both under the 15 floor, i.e. adjacent stack segments that
// full-color readers cannot tell apart. Re-validated against THIS app's chart
// surface (bg-card: #ffffff / #171717, not the reference's):
//   light  → ALL PASS (worst adjacent CVD ΔE 9.1, normal-vision 19.6)
//   dark   → ALL PASS (worst adjacent CVD ΔE 8.4, normal-vision 19.3)
// Re-run before touching:
//   node scripts/validate_palette.js "<hexes>" --mode light --surface "#ffffff"
//   node scripts/validate_palette.js "<hexes>" --mode dark  --surface "#171717"
// Light carries a documented contrast WARN (magenta/yellow/aqua sit below 3:1 on
// white) — discharged by the relief rule: every series is also named in a legend
// and in the sessions table, so hue never carries meaning alone.
//
// `status` is the RESERVED status ramp — deliberately distinct steps so a status
// color can never impersonate a series, and vice versa. Only ever used where the
// color MEANS state (context pressure), always paired with an icon + label.
const THEME = {
  dark: {
    fg: '#fafafa', muted: '#a1a1a1', card: '#171717', bg: '#0a0a0a',
    grid: '#2c2c2a', border: 'rgba(255,255,255,0.10)',
    cat: ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'],
    heat: ['#233457', '#6aa8f5'], heatEmpty: '#1f1f1f',
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
    // Meter track: a lighter step of the same blue ramp, so state reads across
    // the whole bar rather than only where it's filled.
    track: '#233457',
  },
  light: {
    fg: '#0a0a0a', muted: '#737373', card: '#ffffff', bg: '#f5f5f5',
    grid: '#e5e5e5', border: 'rgba(10,10,10,0.10)',
    cat: ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948'],
    heat: ['#dbeafe', '#1e40af'], heatEmpty: '#efefef',
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
    track: '#cde2fb',
  },
} as const;

// ---- formatting ----
function formatUsd(n: number): string {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}
/** Sub-dollar amounts, for per-message cost where $0.00 would erase the signal. */
function formatUsdFine(n: number): string {
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 1) return '$' + n.toFixed(2);
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(3);
}
const fmt = (n: number, m: Measure) => (m === 'cost' ? formatUsd(n) : formatTokens(n));
// Bare number — the axis tick / column header / card label already says the unit.
// Uses the anchored regex so the singular "1 token" is stripped too (a plain
// .replace(' tokens','') misses it and leaks the unit into the axis).
const bare = (n: number) => formatTokens(n).replace(/ tokens?$/, '');
const fmtShort = (n: number, m: Measure) => (m === 'cost' ? formatUsd(n) : bare(n));
const modelLabel = (m: string) => (m === 'unknown' ? 'unknown' : m.replace(/^claude-/, ''));
const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Context fill → reserved status color. Never a categorical slot: this color
 *  MEANS state, and is always shipped alongside the numeric % (and an icon in
 *  the table), so it never carries meaning alone. */
function fillStatus(fill: number, t: typeof THEME.dark | typeof THEME.light): string {
  if (fill >= 0.9) return t.status.critical;
  if (fill >= HOT_FILL) return t.status.warning;
  return t.cat[0];
}

/** The browser's IANA timezone, sent to the API so day buckets are truly local. */
const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; }
  catch { return 'America/New_York'; }
})();

// ---- ECharts wrapper: init once, setOption on change, resize + dispose ----
function EChart({ option, className }: { option: echarts.EChartsOption; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current);
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);
  useEffect(() => { chart.current?.setOption(option, true); }, [option]);
  return <div ref={ref} className={className} />;
}

// ---- stat tile ----
function StatTile({ label, value, sub, hero }: { label: string; value: string; sub?: string; hero?: boolean }) {
  // Top-aligned so the value (second row) lines up across every card, whether
  // or not the card has a sub-line. A non-breaking space holds the sub row's
  // height when absent, keeping the third row aligned too.
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`mt-2 font-semibold text-foreground ${hero ? 'text-3xl' : 'text-2xl'}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub || ' '}</div>
    </div>
  );
}

/**
 * Meter — a single ratio against a limit (context used ÷ model window).
 *
 * The form heuristic's answer for exactly this data: not a bar chart, not a
 * 2-slice pie. The unfilled track is a lighter step of the SAME blue ramp
 * (never a neutral gray), so the bar reads as one object and state carries
 * across its whole length. The fill takes the reserved status ramp once it's
 * hot; the numeric % always renders beside it, so color is never the only
 * channel.
 *
 * `window === 0` means the denominator is unknowable (session predates window
 * capture) — we render the size with no track and no %, rather than inventing a
 * denominator. That's why `fill` is not simply `used / (window || 200_000)`.
 */
function Meter({
  fill, label, title, t,
}: { fill: number | null; label: string; title?: string; t: typeof THEME.dark | typeof THEME.light }) {
  // fill === null ⇒ denominator unknown. Render the value with NO track and no
  // %, but keep the track's footprint as a spacer: this column is tabular-nums,
  // and without the spacer an unmetered row's number drifts right (past where
  // the metered numbers sit) and the column stops aligning. Reserving the space
  // is also honest — it shows there's a bar missing, not that the bar is empty.
  const clamped = fill === null ? 0 : Math.max(0, Math.min(1, fill));
  return (
    <div className="flex items-center gap-2 justify-end" title={title}>
      <span className="tabular-nums text-muted-foreground w-[3.5rem] text-right">{label}</span>
      {fill === null ? (
        <div className="h-1.5 w-14 shrink-0" aria-hidden />
      ) : (
        <div
          className="h-1.5 w-14 rounded-full overflow-hidden shrink-0"
          style={{ background: t.track }}
          role="meter"
          aria-valuenow={Math.round(clamped * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${clamped * 100}%`, background: fillStatus(clamped, t) }}
          />
        </div>
      )}
    </div>
  );
}

// ---- segmented control ----
function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs rounded transition-colors ${
            value === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >{o.label}</button>
      ))}
    </div>
  );
}

/** The user's restorable view: date range, $/tokens framing, table sort, and
 *  the flagged-only filter. Persisted via /api/ui-state (see page.tsx). */
export interface StatsPrefs {
  measure: Measure;
  range: Range;
  sortKey: string;
  sortDir: 1 | -1;
  onlyFlagged: boolean;
}

/** Every column the sessions table can sort by. A restored `sortKey` is checked
 *  against this so a stale/renamed column from an old saved state can't leave
 *  the table sorting by a field that no longer exists. */
const SORTABLE_KEYS = new Set<keyof SessionRow>([
  'day', 'projectName', 'display', 'messages', 'peakContext',
  'costPerMsg', 'tokensPerMsg', 'tokens', 'cost',
]);

interface StatsTabProps {
  isActive: boolean;
  /** Open a session's transcript in the Chat tab. */
  onOpenSession: (sessionId: string, project: string, display: string) => void;
  /** Last-saved view, restored on mount. Absent fields fall back to defaults.
   *  Read once at mount (StatsTab only mounts after page.tsx has loaded UI
   *  state), so no live-sync effect is needed. */
  initialPrefs?: Partial<StatsPrefs>;
  /** Fired when the user changes any restorable control, for page.tsx to
   *  persist. Not called for the initial restore. */
  onPrefsChange?: (prefs: StatsPrefs) => void;
}

export default function StatsTab({ isActive, onOpenSession, initialPrefs, onPrefsChange }: StatsTabProps) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Measure ($/tokens) only re-scales the charts — a single plot cannot carry
  // dollars and tokens at once without a second y-axis, which is the one thing a
  // chart must never do. The KPI row shows both framings regardless. This and
  // the other view controls are restored from the last visit (see initialPrefs).
  const [measure, setMeasure] = useState<Measure>(() => initialPrefs?.measure ?? 'cost');
  const [range, setRange] = useState<Range>(() => initialPrefs?.range ?? 'all');
  // Lazy-init from the live theme to avoid a one-frame flash for light-mode users.
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  const [sort, setSort] = useState<{ key: keyof SessionRow; dir: 1 | -1 }>(() => {
    // Default: newest first. `day` is a "YYYY-MM-DD" string that sorts
    // chronologically, and dir -1 puts the most recent session on top;
    // same-day sessions keep the API's lastMs-desc order. A saved sort
    // preference overrides this.
    const k = initialPrefs?.sortKey;
    const key = (k && SORTABLE_KEYS.has(k as keyof SessionRow) ? k : 'day') as keyof SessionRow;
    return { key, dir: initialPrefs?.sortDir === 1 ? 1 : -1 };
  });
  // Narrow the table to sessions that ran hot or were compacted.
  const [onlyFlagged, setOnlyFlagged] = useState(() => initialPrefs?.onlyFlagged ?? false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const wasActive = useRef(false);

  // Persist the view in the control handlers, not via a [measure, range, …]
  // effect. An effect firing on every value change looks tidy but (a) fires a
  // spurious write on mount that a ref-guard can't reliably suppress — React
  // StrictMode double-invokes effects and the ref survives the pair — and (b)
  // can't tell a user edit from the initial restore. Emitting from the handler
  // writes only on genuine interaction, and reverting a control back to its
  // default still writes (the change IS the signal), so the stored view never
  // lies about what's on screen. Mirrors saveLayoutState's handler-based save.
  //
  // Each control changes independently, so the unchanged fields are read from
  // the current render's state and `next` overrides just the one that moved.
  const emitPrefs = (next: Partial<StatsPrefs>) =>
    onPrefsChange?.({ measure, range, sortKey: sort.key, sortDir: sort.dir, onlyFlagged, ...next });

  const changeMeasure = (m: Measure) => { setMeasure(m); emitPrefs({ measure: m }); };
  const changeRange = (r: Range) => { setRange(r); emitPrefs({ range: r }); };
  const changeOnlyFlagged = (v: boolean) => { setOnlyFlagged(v); emitPrefs({ onlyFlagged: v }); };

  // Track theme (globals.css toggles `.dark` on <html>).
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains('dark'));
    update();
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stats?tz=${encodeURIComponent(BROWSER_TZ)}`);
      if (!res.ok) throw new Error('request failed');
      setData(await res.json());
      setError(null);
    } catch {
      setError('Failed to load stats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  // Refresh when the tab (re)gains focus, to pick up newly archived sessions.
  useEffect(() => {
    if (isActive && !wasActive.current) fetchData();
    wasActive.current = isActive;
  }, [isActive, fetchData]);

  const t = dark ? THEME.dark : THEME.light;

  // Fixed color per entity (stable API order) — never repaint on filter.
  const modelColor = useMemo(() => {
    const map: Record<string, string> = {};
    (data?.models ?? []).forEach((m, i) => { map[m] = t.cat[i % t.cat.length]; });
    return map;
  }, [data?.models, t]);

  // Stable color per project, keyed by full-history cost rank (filter-
  // independent), so changing the range never repaints surviving projects.
  const projectColor = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of data?.sessions ?? []) {
      const k = s.projectName || '—';
      totals.set(k, (totals.get(k) ?? 0) + s.cost);
    }
    const order = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const map: Record<string, string> = {};
    order.forEach((n, i) => { map[n] = t.cat[i % t.cat.length]; });
    return map;
  }, [data?.sessions, t]);

  // Day formatter in the API's timezone, so cutoffs match the server's buckets.
  const localDay = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: data?.timezone || 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return (ms: number) => fmt.format(new Date(ms));
  }, [data?.timezone]);

  // Date-range cutoff (inclusive) as a "YYYY-MM-DD" string in the API's zone.
  const cutoff = useMemo(() => {
    if (!data) return null;
    if (range === 'all') return null;
    if (range === 'mtd') return data.today.slice(0, 8) + '01';
    const n = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    return localDay(data.generatedAt - (n - 1) * 86_400_000);
  }, [range, data, localDay]);

  const daily = useMemo(
    () => (data?.daily ?? []).filter(d => !cutoff || d.day >= cutoff),
    [data, cutoff],
  );
  const sessions = useMemo(
    () => (data?.sessions ?? []).filter(s => !cutoff || s.day >= cutoff),
    [data, cutoff],
  );

  // ---- KPIs ----
  //
  // NOTE — the "cache hit rate" tile that used to live here was removed, not
  // moved. It computed cacheRead / (input + cacheWrite + cacheRead), which for
  // Claude Code is a near-constant ~90%+ and, worse, reads BACKWARDS for this
  // tab's purpose: a bloated session re-reads its giant carried context on every
  // call, so cacheRead dominates and the "efficiency" number goes UP as the
  // session gets worse. It rewarded exactly what we're trying to surface. The
  // normalized per-message cost and the hot-session count below are the honest
  // replacements: both go the right way.
  const kpi = useMemo(() => {
    let tokens = 0, cost = 0;
    const days = new Set<string>();
    for (const d of daily) {
      tokens += d.tokens; cost += d.cost;
      days.add(d.day);
    }
    // Per-message is computed over session TOTALS, not by averaging each
    // session's own rate: a 2-message session at $0.90/msg would otherwise
    // weigh as much as a 300-message one, and the mean would track outliers
    // instead of reality.
    let msgs = 0;
    for (const s of sessions) msgs += s.messages;
    // "Hot" = the session's peak main-thread prompt crossed HOT_FILL of its
    // window. Only sessions with a KNOWN window can be judged (peakFill is 0
    // when the API couldn't determine a denominator), so they're excluded from
    // both numerator and denominator rather than silently counted as fine.
    const judgeable = sessions.filter(s => s.contextWindow > 0);
    const hot = judgeable.filter(s => s.peakFill >= HOT_FILL);
    const compacted = sessions.filter(s => s.numCompactions > 0);
    return {
      tokens, cost,
      activeDays: days.size,
      perDay: days.size ? (measure === 'cost' ? cost : tokens) / days.size : 0,
      sessions: sessions.length,
      projects: new Set(sessions.map(s => s.projectName || '—')).size,
      messages: msgs,
      costPerMsg: msgs ? cost / msgs : 0,
      tokensPerMsg: msgs ? tokens / msgs : 0,
      hot: hot.length,
      judgeable: judgeable.length,
      compacted: compacted.length,
    };
  }, [daily, sessions, measure]);

  const val = (d: { tokens: number; cost: number }) => (measure === 'cost' ? d.cost : d.tokens);

  // ---- daily stacked bar (by model) ----
  const dailyOption = useMemo<echarts.EChartsOption>(() => {
    const days = [...new Set(daily.map(d => d.day))].sort();
    const modelsPresent = data?.models.filter(m => daily.some(d => d.model === m)) ?? [];
    const byKey = new Map(daily.map(d => [d.day + '|' + d.model, d]));
    const series: echarts.BarSeriesOption[] = modelsPresent.map(m => ({
      name: modelLabel(m),
      type: 'bar',
      stack: 'total',
      barMaxWidth: 22,
      itemStyle: { color: modelColor[m], borderColor: t.card, borderWidth: 1.5, borderRadius: [2, 2, 0, 0] },
      emphasis: { focus: 'series' },
      data: days.map(day => val(byKey.get(day + '|' + m) ?? { tokens: 0, cost: 0 })),
    }));
    return {
      textStyle: { fontFamily: 'inherit' },
      grid: { left: 8, right: 16, top: 40, bottom: 24, containLabel: true },
      legend: {
        top: 6, left: 0, itemWidth: 10, itemHeight: 10, itemGap: 14,
        textStyle: { color: t.muted, fontSize: 11 }, icon: 'roundRect',
      },
      tooltip: {
        trigger: 'axis', backgroundColor: t.card, borderColor: t.border, borderWidth: 1,
        textStyle: { color: t.fg, fontSize: 12 },
        axisPointer: { type: 'shadow', shadowStyle: { color: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' } },
        formatter: (params: any) => {
          const arr = Array.isArray(params) ? params : [params];
          let total = 0;
          const rows = arr
            .filter(p => p.value > 0)
            .sort((a, b) => b.value - a.value)
            .map(p => {
              total += p.value;
              return `<div style="display:flex;justify-content:space-between;gap:16px">
                <span>${p.marker}${p.seriesName}</span><span style="font-variant-numeric:tabular-nums">${fmt(p.value, measure)}</span></div>`;
            }).join('');
          return `<div style="font-weight:600;margin-bottom:4px">${arr[0]?.axisValue}</div>${rows}
            <div style="display:flex;justify-content:space-between;gap:16px;margin-top:4px;border-top:1px solid ${t.border};padding-top:4px">
            <span>Total</span><span style="font-variant-numeric:tabular-nums">${fmt(total, measure)}</span></div>`;
        },
      },
      xAxis: {
        type: 'category', data: days,
        axisLine: { lineStyle: { color: t.grid } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 10, formatter: (v: string) => v.slice(5) },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: t.grid } },
        axisLabel: {
          color: t.muted, fontSize: 10,
          formatter: (v: number) => (measure === 'cost' ? formatUsd(v).replace('.00', '') : bare(v)),
        },
      },
      dataZoom: days.length > 45 ? [{ type: 'inside', throttle: 60 }] : undefined,
      series,
    };
  }, [daily, data?.models, modelColor, measure, t, dark]);

  // ---- calendar heatmap ----
  const calendarOption = useMemo<echarts.EChartsOption>(() => {
    const perDay = new Map<string, number>();
    let max = 0;
    for (const d of daily) {
      const v = (perDay.get(d.day) ?? 0) + val(d);
      perDay.set(d.day, v);
      if (v > max) max = v;
    }
    const days = [...perDay.keys()].sort();
    const rangeSpec = days.length
      ? [days[0], days[days.length - 1]]
      : [data?.today ?? '2026-01-01', data?.today ?? '2026-01-01'];
    return {
      textStyle: { fontFamily: 'inherit' },
      tooltip: {
        backgroundColor: t.card, borderColor: t.border, borderWidth: 1,
        textStyle: { color: t.fg, fontSize: 12 },
        formatter: (p: any) => `${p.data[0]}<br/><b>${fmt(p.data[1], measure)}</b>`,
      },
      visualMap: {
        min: 0, max: max || 1, type: 'continuous', calculable: false, show: false,
        inRange: { color: t.heat },
      },
      calendar: {
        top: 28, left: 28, right: 12, bottom: 8, cellSize: ['auto', 15],
        range: rangeSpec,
        itemStyle: { color: t.heatEmpty, borderColor: t.bg, borderWidth: 2 },
        splitLine: { show: false },
        yearLabel: { show: false },
        monthLabel: { color: t.muted, fontSize: 10 },
        dayLabel: { color: t.muted, fontSize: 9, firstDay: 0 },
      },
      series: {
        type: 'heatmap', coordinateSystem: 'calendar',
        data: days.map(d => [d, perDay.get(d) ?? 0]),
        itemStyle: { borderColor: t.bg, borderWidth: 2, borderRadius: 2 },
      },
    };
  }, [daily, measure, t, data?.today]);

  // ---- donuts ----
  const donutOption = useCallback((entries: { name: string; value: number; color: string }[]): echarts.EChartsOption => ({
    textStyle: { fontFamily: 'inherit' },
    tooltip: {
      trigger: 'item', backgroundColor: t.card, borderColor: t.border, borderWidth: 1,
      textStyle: { color: t.fg, fontSize: 12 },
      formatter: (p: any) => `${p.marker}${p.name}<br/><b>${fmt(p.value, measure)}</b> · ${p.percent}%`,
    },
    legend: {
      type: 'scroll', orient: 'vertical', right: 4, top: 'center',
      itemWidth: 10, itemHeight: 10, icon: 'roundRect',
      textStyle: { color: t.muted, fontSize: 11 },
    },
    series: [{
      type: 'pie', radius: ['52%', '78%'], center: ['34%', '50%'],
      avoidLabelOverlap: true, label: { show: false }, labelLine: { show: false },
      itemStyle: { borderColor: t.card, borderWidth: 2 },
      data: entries.map(e => ({ name: e.name, value: e.value, itemStyle: { color: e.color } })),
    }],
  }), [t, measure]);

  const byModelDonut = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of daily) totals.set(d.model, (totals.get(d.model) ?? 0) + val(d));
    const entries = (data?.models ?? [])
      .filter(m => (totals.get(m) ?? 0) > 0)
      .map(m => ({ name: modelLabel(m), value: totals.get(m) ?? 0, color: modelColor[m] }));
    return donutOption(entries);
  }, [daily, data?.models, modelColor, donutOption]);

  const byProjectDonut = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of sessions) totals.set(s.projectName || '—', (totals.get(s.projectName || '—') ?? 0) + (measure === 'cost' ? s.cost : s.tokens));
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7);
    const rest = sorted.slice(7).reduce((s, [, v]) => s + v, 0);
    const entries: { name: string; value: number; color: string }[] =
      top.map(([name, value]) => ({ name, value, color: projectColor[name] ?? t.muted }));
    if (rest > 0) entries.push({ name: 'Other', value: rest, color: t.muted });
    return donutOption(entries);
  }, [sessions, donutOption, measure, t, projectColor]);

  // ---- sessions table ----
  // Sessions worth acting on: hot (known fill ≥ HOT_FILL) or already compacted.
  // Compaction is the strongest bloat evidence we have — it means the
  // conversation actually hit the wall and detail was thrown away — and unlike
  // fill it needs no window, so it covers the sessions fill can't judge.
  // MUST be declared before sortedSessions, which reads it during render.
  const flagged = useMemo(
    () => sessions.filter(s => s.numCompactions > 0 || (s.contextWindow > 0 && s.peakFill >= HOT_FILL)),
    [sessions],
  );

  const sortedSessions = useMemo(() => {
    const s = onlyFlagged ? [...flagged] : [...sessions];
    const { key, dir } = sort;
    s.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return s;
  }, [sessions, sort, onlyFlagged, flagged]);

  const toggleSort = (key: keyof SessionRow) => {
    // Compute the next sort from the current render's value (not a functional
    // updater) so we can persist the same object we set.
    const next: { key: keyof SessionRow; dir: 1 | -1 } =
      sort.key === key ? { key, dir: (sort.dir * -1) as 1 | -1 } : { key, dir: -1 };
    setSort(next);
    emitPrefs({ sortKey: next.key, sortDir: next.dir });
  };

  const measureOpts: { value: Measure; label: string }[] = [{ value: 'cost', label: '$' }, { value: 'tokens', label: 'Tokens' }];
  const rangeOpts: { value: Range; label: string }[] = [
    { value: 'all', label: 'All' }, { value: 'mtd', label: 'MTD' },
    { value: '7d', label: '7d' }, { value: '30d', label: '30d' }, { value: '90d', label: '90d' },
  ];

  const empty = !loading && data && data.sessions.length === 0;

  return (
    <div className="h-full overflow-auto bg-background">
      <div className={`mx-auto max-w-6xl p-4 space-y-4 transition-opacity ${loading && data ? 'opacity-60' : ''}`}>
        {/* Header + filters */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Stats</h1>
            <p className="text-xs text-muted-foreground">
              Token usage &amp; estimated cost · {data ? `daily by ${data.timezone.split('/').pop()?.replace(/_/g, ' ')} time` : '…'}
              {data && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setPricingOpen(true)}
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    title="View model pricing"
                  >
                    pricing as of {data.pricingAsOf}
                  </button>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented options={rangeOpts} value={range} onChange={changeRange} />
            <Segmented options={measureOpts} value={measure} onChange={changeMeasure} />
            <button
              onClick={fetchData}
              className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {data?.unpriced.events ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
            {formatTokens(data.unpriced.tokens)} from {data.unpriced.events} events use a model with no pricing entry — excluded from cost.
          </div>
        ) : null}

        {empty ? (
          <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            No usage recorded yet.
          </div>
        ) : !data ? (
          <div className="p-10 text-center text-sm text-muted-foreground">{loading ? 'Loading…' : ''}</div>
        ) : (
          <>
            {/* KPI tiles — both framings always present, so neither plan has to
                read past a number that doesn't apply to it. Spend and tokens sit
                side by side (tiles 1–2); the efficiency tile carries both rates
                at once. Only the charts follow the $/Tokens toggle, because a
                single plot can't carry two units without a second y-axis. */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatTile
                hero
                label="Estimated spend"
                value={formatUsd(kpi.cost)}
                sub={range === 'all' ? 'all time' : range.toUpperCase()}
              />
              <StatTile
                label="Total tokens"
                value={bare(kpi.tokens)}
                sub={`${fmtShort(kpi.perDay, measure)} per active day · ${kpi.activeDays} day${kpi.activeDays === 1 ? '' : 's'}`}
              />
              <StatTile
                label="Sessions"
                value={kpi.sessions.toLocaleString()}
                sub={`Across ${kpi.projects} project${kpi.projects === 1 ? '' : 's'}`}
              />
              {/* Replaces the old "cache hit rate", which rose as sessions got
                  WORSE (a bloated session re-reads its carried context every
                  call, so cache reads dominate). Per-message divides session
                  length back out, so this moves only when efficiency moves. */}
              <StatTile
                label="Per message"
                value={formatUsdFine(kpi.costPerMsg)}
                sub={`${bare(kpi.tokensPerMsg)} tokens · ${kpi.messages.toLocaleString()} msgs`}
              />
              <StatTile
                label="Ran hot"
                value={kpi.judgeable > 0 ? `${kpi.hot}` : '—'}
                sub={
                  kpi.judgeable > 0
                    ? `of ${kpi.judgeable} measurable · ${kpi.compacted} compacted`
                    : `window unknown · ${kpi.compacted} compacted`
                }
              />
            </div>

            {/* Daily stacked */}
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium text-foreground mb-1 px-1">{measure === 'cost' ? 'Daily spend' : 'Daily tokens'} by model</div>
              <EChart option={dailyOption} className="w-full h-[280px]" />
            </div>

            {/* Calendar heatmap */}
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium text-foreground mb-1 px-1">Calendar — {measure === 'cost' ? 'spend' : 'tokens'} per day</div>
              <EChart option={calendarOption} className="w-full h-[160px]" />
            </div>

            {/* Donuts */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-sm font-medium text-foreground mb-1 px-1">By model</div>
                <EChart option={byModelDonut} className="w-full h-[240px]" />
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-sm font-medium text-foreground mb-1 px-1">By project</div>
                <EChart option={byProjectDonut} className="w-full h-[240px]" />
              </div>
            </div>

            {/* Sessions table — also the chart's table view, so every value the
                charts encode in color is reachable as text (the light palette's
                sub-3:1 hues depend on this for relief). */}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="flex flex-wrap items-baseline justify-between gap-2 p-3 pb-2">
                <div className="text-sm font-medium text-foreground">
                  Sessions
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    click a row to open it in Chat
                  </span>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-current"
                    checked={onlyFlagged}
                    onChange={e => changeOnlyFlagged(e.target.checked)}
                  />
                  Only ran hot or compacted ({flagged.length})
                </label>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-y border-border">
                      {([
                        ['day', 'Date', 'left'], ['projectName', 'Project', 'left'], ['display', 'Title', 'left'],
                        ['messages', 'Msgs', 'right'],
                        ['peakContext', 'Peak context', 'right'],
                        [measure === 'cost' ? 'costPerMsg' : 'tokensPerMsg', 'Per msg', 'right'],
                        ['tokens', 'Tokens', 'right'], ['cost', 'Cost', 'right'],
                      ] as [keyof SessionRow, string, string][]).map(([key, label, align]) => (
                        <th
                          key={key}
                          onClick={() => toggleSort(key)}
                          className={`px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}
                        >
                          {label}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSessions.map(s => {
                      const hot = s.contextWindow > 0 && s.peakFill >= HOT_FILL;
                      return (
                        <tr
                          key={s.sessionId}
                          onClick={() => s.project && onOpenSession(s.sessionId, s.project, s.display)}
                          className="border-b border-border/50 hover:bg-muted/40 cursor-pointer"
                        >
                          <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap tabular-nums">{s.day.slice(5)}</td>
                          <td className="px-3 py-1.5 text-foreground whitespace-nowrap max-w-[160px] truncate" title={s.project}>{s.projectName}</td>
                          <td className="px-3 py-1.5 text-muted-foreground max-w-[280px] truncate" title={s.display}>
                            <span className="inline-flex items-center gap-1.5">
                              {s.models.map(m => <span key={m} className="inline-block h-2 w-2 rounded-sm shrink-0" style={{ background: modelColor[m] ?? t.muted }} title={modelLabel(m)} />)}
                              {/* Status icons ride the row, never color alone.
                                  Rendered independently: a session can be both
                                  compacted AND hot — the worst state — and a
                                  ternary would drop the second signal. */}
                              {s.numCompactions > 0 && (
                                <span
                                  className="shrink-0 inline-flex"
                                  title={`Context was auto-summarised ${s.numCompactions}× — earlier detail may be lost`}
                                >
                                  <ShieldAlert
                                    className="h-3 w-3"
                                    style={{ color: t.status.serious }}
                                    aria-label={`Auto-summarised ${s.numCompactions} times`}
                                  />
                                </span>
                              )}
                              {hot && (
                                <span
                                  className="shrink-0 inline-flex"
                                  title={`Peaked at ${pct(s.peakFill)} of its context window`}
                                >
                                  <AlertTriangle
                                    className="h-3 w-3"
                                    style={{ color: fillStatus(s.peakFill, t) }}
                                    aria-label={`Peaked at ${pct(s.peakFill)} of context window`}
                                  />
                                </span>
                              )}
                              <span className="truncate">{s.display}</span>
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{s.messages}</td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {s.peakContext > 0 ? (
                              // fill=null when the window is unknown ⇒ no
                              // denominator ⇒ no track and no %. Never guess
                              // one; Meter keeps the column aligned regardless.
                              <Meter
                                fill={s.contextWindow > 0 ? s.peakFill : null}
                                label={bare(s.peakContext)}
                                title={
                                  s.contextWindow > 0
                                    ? `${bare(s.peakContext)} of ${bare(s.contextWindow)} — ${pct(s.peakFill)} full at its peak`
                                    : `${bare(s.peakContext)} peak — context window unknown for this session, so fill % can't be computed`
                                }
                                t={t}
                              />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right text-foreground tabular-nums">
                            {measure === 'cost'
                              ? (s.priced ? formatUsdFine(s.costPerMsg) : '—')
                              : bare(Math.round(s.tokensPerMsg))}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{bare(s.tokens)}</td>
                          <td className="px-3 py-1.5 text-right text-foreground tabular-nums">{s.priced ? formatUsd(s.cost) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {sortedSessions.length === 0 && (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    No sessions match this filter.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} />
    </div>
  );
}
