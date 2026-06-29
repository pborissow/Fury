'use client';

import { useEffect, useRef, useState } from 'react';

// Cumulative output tokens → compact label. <1000 shown raw ("57 tokens"),
// ≥1000 rounded to whole thousands ("194k tokens").
export function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`;
  return `${n} token${n === 1 ? '' : 's'}`;
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

export default function AnimatedTokenCount({ value }: { value: number }) {
  const display = useAnimatedNumber(value);
  return <>{formatTokens(Math.round(display))}</>;
}
