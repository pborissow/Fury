'use client';

import { useEffect, useState } from 'react';
import Dialog from '@/components/Dialog';

/**
 * Shared model-pricing reference modal. Rendered from two places — the Stats
 * tab header ("pricing as of …") and the model-catalog "Refresh model list"
 * dialog — so it owns its own data fetch and is driven purely by `open`.
 *
 * Shows the exact rates costForUsage charges from (git-versioned constant +
 * any poller overrides), fetched from /api/pricing/table, so the card can never
 * drift from the numbers on the Stats tab.
 */

interface RatePeriod {
  effectiveFrom: string;
  input: number; output: number;
  cacheWrite5m: number; cacheWrite1h: number; cacheRead: number;
}
interface ModelPricing {
  id: string;
  displayName: string;
  periods: RatePeriod[];
  current: RatePeriod;
  /** Empirically-learned default served window; null = unknown (never probed). */
  baseWindow: number | null;
}
interface PricingTable {
  asOf: string;
  hasOverrides: boolean;
  models: ModelPricing[];
}

/** $/Mtok — a fixed 2-decimal price ($0.10, $6.25, $75.00). */
const usd = (n: number) => '$' + n.toFixed(2);
/** Base context window as a compact label; em dash when unknown. */
const win = (n: number | null) =>
  n == null ? '—' : n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;

export default function PricingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<PricingTable | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Fetch each time it opens — pricing rarely changes, but a poller override
  // could land between opens, and the payload is tiny.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch('/api/pricing/table')
      .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
      .then(json => { if (!cancelled) setData(json); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const cols = ['Model', 'Base context', 'Input', 'Output', 'Cache write 5m', 'Cache write 1h', 'Cache read'];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Model pricing"
      defaultWidth={760}
      defaultHeight={560}
      minWidth={520}
      minHeight={320}
      maximizable
      buttons={[{ label: 'Close', onClick: () => onOpenChange(false), variant: 'ghost' }]}
    >
      <div className="text-sm">
        <p className="text-xs text-muted-foreground mb-3">
          Rates in USD per million tokens{data ? <> · as of {data.asOf}</> : null}.
          These are the rates the Stats tab prices with.
          {data?.hasOverrides ? ' Includes live-updated rates from the pricing poller.' : ''}
        </p>

        {loading && !data ? (
          <div className="py-10 text-center text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="py-10 text-center text-destructive">Failed to load pricing.</div>
        ) : data ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-y border-border">
                  {cols.map((c, i) => (
                    <th key={c} className={`px-2.5 py-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.models.map(m => {
                  const r = m.current;
                  // Surface a dated price change if one exists; today every model
                  // has a single '' (inception) period, so this stays hidden.
                  const dated = r.effectiveFrom ? ` · since ${r.effectiveFrom}` : '';
                  return (
                    <tr key={m.id} className="border-b border-border/50 hover:bg-muted/40">
                      <td className="px-2.5 py-1.5 text-foreground whitespace-nowrap">
                        {m.displayName}
                        <span className="ml-1.5 text-[10px] text-muted-foreground font-mono">{m.id}{dated}</span>
                      </td>
                      <td
                        className="px-2.5 py-1.5 text-right text-muted-foreground tabular-nums"
                        title={m.baseWindow == null
                          ? 'Base window unknown — not yet probed on this install'
                          : 'Default served window (larger variants may be available)'}
                      >
                        {win(m.baseWindow)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-foreground tabular-nums">{usd(r.input)}</td>
                      <td className="px-2.5 py-1.5 text-right text-foreground tabular-nums">{usd(r.output)}</td>
                      <td className="px-2.5 py-1.5 text-right text-muted-foreground tabular-nums">{usd(r.cacheWrite5m)}</td>
                      <td className="px-2.5 py-1.5 text-right text-muted-foreground tabular-nums">{usd(r.cacheWrite1h)}</td>
                      <td className="px-2.5 py-1.5 text-right text-muted-foreground tabular-nums">{usd(r.cacheRead)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
              Cache rates follow the published multipliers on base input: writes are
              1.25× (5-minute TTL) and 2× (1-hour), reads 0.1×. Claude Code writes at
              the 1-hour TTL, so that column drives most cache-write spend. Estimates
              exclude web-search and other server-tool charges. Base context is the
              default served window observed for this account (larger variants may
              exist); “—” means it hasn’t been probed here yet.
            </p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
