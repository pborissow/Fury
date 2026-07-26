/**
 * Pure freshness-leaf state — extracted from components/FreshnessLeaf.tsx so the
 * render decision is unit-testable without mounting React (mirrors the same split
 * lib/transcriptStrip.ts made for the in-flight strip).
 *
 * The Anthropic prompt cache has a ~5-minute TTL, refreshed on every turn, so a
 * session resumed within that window reuses the warm cache (cheap cache_read)
 * instead of paying a full cold re-cache. The leaf visualizes that window per
 * session. `computeFreshnessView` maps a clock reading to the leaf's appearance:
 *
 *  - `live` (a turn is in flight): pinned FULL-GREEN with a "warm" title and NEVER
 *    hidden, however long the turn runs — the countdown must not expire mid-turn.
 *    This is what keeps the leaf correct during a long turn OR a background-task
 *    window, where `live` stays true the whole time
 *    (docs/ticket-freshness-leaf-false-stale.md,
 *    docs/ticket-background-task-notification-turns-render-dark.md).
 *  - not live: interpolate green→yellow across the TTL measured from `lastActiveAt`,
 *    and return null (leaf hidden) once past the TTL — the session has gone cold.
 */
export const FRESHNESS_TTL_MS = 5 * 60 * 1000;

export interface FreshnessView {
  /** hsl() color for the leaf icon. */
  color: string;
  /** Tooltip text (the acceptance signal the freshness ticket asserts on). */
  title: string;
}

/**
 * The leaf's visual state at clock `now` for a session last active at
 * `lastActiveAt`, or `null` when the leaf must not render (cold: not live and past
 * the TTL). Pure — no Date.now(), no state — so the component can own the clock/tick
 * and this can be asserted deterministically.
 */
export function computeFreshnessView(
  now: number,
  lastActiveAt: number,
  live: boolean,
): FreshnessView | null {
  const age = now - lastActiveAt;
  // Cold: not live and past the TTL → the leaf disappears.
  if (!live && age >= FRESHNESS_TTL_MS) return null;

  // Pinned full-green while live; otherwise interpolate green→yellow across the
  // TTL. Clamp so clock skew (lastActiveAt in the future) can't push frac < 0.
  const frac = live ? 0 : Math.min(1, Math.max(0, age / FRESHNESS_TTL_MS));
  const hue = 140 - 90 * frac; // 140° green → 50° yellow
  const sat = 65 + 25 * frac;
  const light = 45 + 5 * frac;
  const color = `hsl(${hue} ${sat}% ${light}%)`;

  let title: string;
  if (live) {
    title = 'Session active — prompt cache warm';
  } else {
    const remainMs = Math.max(0, FRESHNESS_TTL_MS - age);
    const m = Math.floor(remainMs / 60000);
    const s = Math.floor((remainMs % 60000) / 1000);
    title = `Prompt cache warm · ~${m}m ${s}s of warmth left`;
  }
  return { color, title };
}
