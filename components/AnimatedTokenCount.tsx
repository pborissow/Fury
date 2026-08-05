'use client';

import { useEffect, useRef, useState } from 'react';

// Cumulative billed tokens → compact label. <1000 shown raw ("57 tokens"),
// thousands rounded ("194k tokens"), millions with one decimal below 10
// ("3.4M tokens") or whole above ("31M tokens").
//
// Used by the Stats tab, where the cumulative framing is correct — cache reads
// really are re-billed per call, so a session's lifetime spend is genuinely in
// the millions. Do NOT use this for a session's context size (see formatContext):
// the two differ by ~150x and callers strip the " tokens" suffix by regex.
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M tokens`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`;
  return `${n} token${n === 1 ? '' : 's'}`;
}

// Current context occupancy → compact label ("194k context").
//
// The millions branch is a ceiling case, not the common one: context is bounded
// by the model's window (~1M today), where the cumulative count above routinely
// reaches tens of millions.
export function formatContext(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M context`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k context`;
  return `${n} context`;
}

// Eases the displayed value toward `target` using exponential approach: each
// frame it closes a fixed fraction of the remaining gap, so it decelerates as
// it nears the end. A moving target (new value mid-flight) widens the gap and
// naturally speeds the count up. The first render shows `target` outright — we
// only animate subsequent changes, so the list doesn't count up from 0 on load.
const EASE = 0.18;

function useAnimatedNumber(target: number): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const targetRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    targetRef.current = target;
    if (displayRef.current === target) return;
    if (rafRef.current != null) return; // loop already running; it reads targetRef

    const tick = () => {
      const cur = displayRef.current;
      const tgt = targetRef.current;
      const diff = tgt - cur;
      if (Math.abs(diff) < 1) {
        displayRef.current = tgt;
        setDisplay(tgt);
        rafRef.current = null;
        return;
      }
      const stepped = diff * EASE;
      // Guarantee at least ±1/frame so integer counts finish promptly.
      const next = cur + (Math.abs(stepped) < 1 ? Math.sign(diff) : stepped);
      displayRef.current = next;
      setDisplay(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [target]);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  return display;
}

/**
 * Eased numeric readout. `format` picks the label — default is the cumulative
 * "N tokens"; the session list passes formatContext for "N context".
 */
export default function AnimatedTokenCount({
  value,
  format = formatTokens,
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const display = useAnimatedNumber(value);
  return <>{format(Math.round(display))}</>;
}
