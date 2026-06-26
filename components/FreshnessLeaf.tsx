'use client';

import { useEffect, useState } from 'react';
import { Leaf } from 'lucide-react';

/**
 * Prompt-cache freshness indicator. The Anthropic prompt cache has a ~5-minute
 * TTL refreshed on each turn, so a session resumed within that window reuses the
 * warm cache (cheap cache_read) instead of paying a full cold re-cache. This
 * leaf visualizes that window per session.
 *
 * While `live` (a turn is in flight) the cache is being refreshed on every
 * token, so the leaf stays pinned full-green no matter how long the turn runs —
 * the countdown must not expire mid-turn. Once the turn ends, `lastActiveAt`
 * (the completion/stop time) anchors the 5-minute green→yellow countdown, after
 * which the leaf disappears.
 */
const TTL_MS = 5 * 60 * 1000;
const TICK_MS = 15 * 1000;

export default function FreshnessLeaf({
  lastActiveAt,
  live = false,
}: {
  lastActiveAt: number;
  live?: boolean;
}) {
  // null until mounted so the first client render matches SSR (Date.now()
  // differs between the two) — same guard pattern as HistoryTimestamp.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    // Pinned warm while the turn runs — no countdown to tick.
    if (live) return;
    // Static & already expired — no need to tick.
    if (Date.now() - lastActiveAt >= TTL_MS) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastActiveAt >= TTL_MS) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [lastActiveAt, live]);

  if (now === null) return null;

  const age = now - lastActiveAt;
  if (!live && age >= TTL_MS) return null;

  // Interpolate green → yellow across the TTL. Pinned full-green while live.
  const frac = live ? 0 : Math.min(1, Math.max(0, age / TTL_MS));
  const hue = 140 - 90 * frac; // 140° green → 50° yellow
  const sat = 65 + 25 * frac;
  const light = 45 + 5 * frac;
  const color = `hsl(${hue} ${sat}% ${light}%)`;

  let title: string;
  if (live) {
    title = 'Session active — prompt cache warm';
  } else {
    const remainMs = Math.max(0, TTL_MS - age);
    const m = Math.floor(remainMs / 60000);
    const s = Math.floor((remainMs % 60000) / 1000);
    title = `Prompt cache warm · ~${m}m ${s}s of warmth left`;
  }

  return (
    <span title={title} className="flex items-center shrink-0">
      <Leaf className="h-3 w-3" style={{ color }} />
    </span>
  );
}
