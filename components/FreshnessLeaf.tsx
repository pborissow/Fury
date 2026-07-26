'use client';

import { useEffect, useState } from 'react';
import { Leaf } from 'lucide-react';
import { FRESHNESS_TTL_MS, computeFreshnessView } from '@/lib/freshness';

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
 *
 * The appearance decision lives in the pure `computeFreshnessView` (lib/freshness.ts)
 * so it can be unit-tested; this component only owns the mount clock + tick.
 */
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
    if (Date.now() - lastActiveAt >= FRESHNESS_TTL_MS) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastActiveAt >= FRESHNESS_TTL_MS) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [lastActiveAt, live]);

  if (now === null) return null;

  const view = computeFreshnessView(now, lastActiveAt, live);
  if (!view) return null;

  return (
    <span title={view.title} className="flex items-center shrink-0">
      <Leaf className="h-3 w-3" style={{ color: view.color }} />
    </span>
  );
}
