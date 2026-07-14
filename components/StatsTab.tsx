'use client';

/**
 * Stats tab — token & estimated-cost analytics over all archived sessions.
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
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { formatTokens } from './AnimatedTokenCount';

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
}
interface StatsData {
  timezone: string; pricingAsOf: string; generatedAt: number; today: string;
  models: string[]; daily: DailyRow[]; sessions: SessionRow[];
  unpriced: { events: number; tokens: number };
}

type Measure = 'cost' | 'tokens';
type Range = 'all' | 'mtd' | '7d' | '30d' | '90d';

// ---- theme (resolved from globals.css oklch tokens → hex for ECharts) ----
// Categorical hues = dataviz validated reference palette (both modes selected).
const THEME = {
  dark: {
    fg: '#fafafa', muted: '#a1a1a1', card: '#171717', bg: '#0a0a0a',
    grid: '#2c2c2a', border: 'rgba(255,255,255,0.10)',
    cat: ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'],
    heat: ['#233457', '#6aa8f5'], heatEmpty: '#1f1f1f',
  },
  light: {
    fg: '#0a0a0a', muted: '#737373', card: '#ffffff', bg: '#f5f5f5',
    grid: '#e5e5e5', border: 'rgba(10,10,10,0.10)',
    cat: ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'],
    heat: ['#dbeafe', '#1e40af'], heatEmpty: '#efefef',
  },
} as const;

// ---- formatting ----
function formatUsd(n: number): string {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}
const fmt = (n: number, m: Measure) => (m === 'cost' ? formatUsd(n) : formatTokens(n));
// KPI values: drop the "tokens" suffix (the card label already says what it is).
const fmtShort = (n: number, m: Measure) => (m === 'cost' ? formatUsd(n) : formatTokens(n).replace(/ tokens?$/, ''));
const modelLabel = (m: string) => (m === 'unknown' ? 'unknown' : m.replace(/^claude-/, ''));

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

export default function StatsTab({ isActive }: { isActive: boolean }) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>('cost');
  const [range, setRange] = useState<Range>('all');
  // Lazy-init from the live theme to avoid a one-frame flash for light-mode users.
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  const [sort, setSort] = useState<{ key: keyof SessionRow; dir: 1 | -1 }>({ key: 'cost', dir: -1 });
  const wasActive = useRef(false);

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
  const kpi = useMemo(() => {
    let tokens = 0, cost = 0, input = 0, cacheWrite = 0, cacheRead = 0;
    const days = new Set<string>();
    for (const d of daily) {
      tokens += d.tokens; cost += d.cost;
      input += d.input; cacheWrite += d.cacheWrite; cacheRead += d.cacheRead;
      days.add(d.day);
    }
    const cacheDenom = input + cacheWrite + cacheRead;
    return {
      tokens, cost,
      activeDays: days.size,
      perDay: days.size ? (measure === 'cost' ? cost : tokens) / days.size : 0,
      sessions: sessions.length,
      projects: new Set(sessions.map(s => s.projectName || '—')).size,
      cacheHit: cacheDenom ? cacheRead / cacheDenom : 0,
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
          formatter: (v: number) => (measure === 'cost' ? formatUsd(v).replace('.00', '') : formatTokens(v).replace(' tokens', '')),
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
  const sortedSessions = useMemo(() => {
    const s = [...sessions];
    const { key, dir } = sort;
    s.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return s;
  }, [sessions, sort]);

  const toggleSort = (key: keyof SessionRow) =>
    setSort(prev => (prev.key === key ? { key, dir: (prev.dir * -1) as 1 | -1 } : { key, dir: -1 }));

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
              {data && <> · pricing as of {data.pricingAsOf}</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented options={rangeOpts} value={range} onChange={setRange} />
            <Segmented options={measureOpts} value={measure} onChange={setMeasure} />
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
            {/* KPI tiles */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatTile hero label={measure === 'cost' ? 'Estimated spend' : 'Total tokens'} value={fmtShort(measure === 'cost' ? kpi.cost : kpi.tokens, measure)} sub={range === 'all' ? 'all time' : range.toUpperCase()} />
              <StatTile label="Per active day" value={fmtShort(kpi.perDay, measure)} sub={`${kpi.activeDays} active day${kpi.activeDays === 1 ? '' : 's'}`} />
              <StatTile label="Sessions" value={kpi.sessions.toLocaleString()} sub={`Across ${kpi.projects} project${kpi.projects === 1 ? '' : 's'}`} />
              <StatTile label="Cache hit rate" value={`${Math.round(kpi.cacheHit * 100)}%`} sub="of input tokens" />
              <StatTile label={measure === 'cost' ? 'Total tokens' : 'Estimated spend'} value={fmtShort(measure === 'cost' ? kpi.tokens : kpi.cost, measure === 'cost' ? 'tokens' : 'cost')} />
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

            {/* Sessions table */}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="text-sm font-medium text-foreground p-3 pb-2">Sessions</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-y border-border">
                      {([
                        ['day', 'Date', 'left'], ['projectName', 'Project', 'left'], ['display', 'Title', 'left'],
                        ['messages', 'Msgs', 'right'], ['tokens', 'Tokens', 'right'], ['cost', 'Cost', 'right'],
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
                    {sortedSessions.map(s => (
                      <tr key={s.sessionId} className="border-b border-border/50 hover:bg-muted/40">
                        <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap tabular-nums">{s.day.slice(5)}</td>
                        <td className="px-3 py-1.5 text-foreground whitespace-nowrap max-w-[160px] truncate" title={s.project}>{s.projectName}</td>
                        <td className="px-3 py-1.5 text-muted-foreground max-w-[280px] truncate" title={s.display}>
                          <span className="inline-flex items-center gap-1.5">
                            {s.models.map(m => <span key={m} className="inline-block h-2 w-2 rounded-sm" style={{ background: modelColor[m] ?? t.muted }} title={modelLabel(m)} />)}
                            {s.display}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{s.messages}</td>
                        <td className="px-3 py-1.5 text-right text-foreground tabular-nums">{formatTokens(s.tokens).replace(' tokens', '')}</td>
                        <td className="px-3 py-1.5 text-right text-foreground tabular-nums">{s.priced ? formatUsd(s.cost) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
