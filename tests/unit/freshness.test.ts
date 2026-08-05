/**
 * Freshness-leaf appearance logic (docs/ticket-freshness-leaf-false-stale.md).
 *
 * Drives the pure computeFreshnessView directly (extracted from FreshnessLeaf.tsx,
 * as transcriptStrip.ts is for the in-flight strip), so the leaf's contract is
 * asserted deterministically without mounting React or waiting real minutes. Maps
 * to the ticket's acceptance criteria:
 *   - live pins full-green with the "warm" title and NEVER hides, even past the TTL
 *     (criteria 1 + 4 — the long-turn / active-window pin the earlier hypothesis
 *     wrongly suspected was a bug);
 *   - idle interpolates green→yellow and hides exactly at the TTL (criterion 3);
 *   - the countdown title reads from lastActiveAt, so a FRESH anchor shows ~full
 *     warmth while a STALE one has already counted down — the false-stale symptom.
 */
import { describe, it, expect } from 'vitest';
import { computeFreshnessView, FRESHNESS_TTL_MS } from '@/lib/freshness';

const NOW = 1_700_000_000_000; // fixed clock; the function is pure so any base works
const FULL_GREEN = 'hsl(140 65% 45%)';

describe('live pin (criteria 1 & 4)', () => {
  it('is full-green with the active title the moment a turn starts (age 0)', () => {
    const view = computeFreshnessView(NOW, NOW, true);
    expect(view).not.toBeNull();
    expect(view!.color).toBe(FULL_GREEN);
    expect(view!.title).toBe('Session active — prompt cache warm');
  });

  it('stays full-green for a turn far longer than the TTL (never counts down mid-turn)', () => {
    // A > 5-min single turn OR a multi-minute background-task window: live stays
    // true the whole time, so the leaf must not yellow or disappear.
    const view = computeFreshnessView(NOW, NOW - 30 * 60 * 1000, true);
    expect(view).not.toBeNull();
    expect(view!.color).toBe(FULL_GREEN);
    expect(view!.title).toBe('Session active — prompt cache warm');
  });
});

describe('idle countdown + expiry (criterion 3)', () => {
  it('a fresh idle anchor shows nearly the full window (~5m) — NOT false-stale', () => {
    // Right after a turn ends, lastActiveAt ≈ now. This is the freshness fix's
    // observable payoff: the countdown starts from the real end, so warmth is high.
    const view = computeFreshnessView(NOW, NOW - 1_000, false); // 1s old
    expect(view).not.toBeNull();
    expect(view!.title).toBe('Prompt cache warm · ~4m 59s of warmth left');
  });

  it('interpolates the tooltip at the halfway point', () => {
    const view = computeFreshnessView(NOW, NOW - FRESHNESS_TTL_MS / 2, false); // 2.5m old
    expect(view).not.toBeNull();
    expect(view!.title).toBe('Prompt cache warm · ~2m 30s of warmth left');
    // Color has moved off full-green toward yellow (hue drops from 140).
    expect(view!.color).not.toBe(FULL_GREEN);
    expect(view!.color).toBe('hsl(95 77.5% 47.5%)');
  });

  it('is still visible one second before the TTL', () => {
    const view = computeFreshnessView(NOW, NOW - (FRESHNESS_TTL_MS - 1_000), false);
    expect(view).not.toBeNull();
    expect(view!.title).toBe('Prompt cache warm · ~0m 1s of warmth left');
  });

  it('disappears (null) exactly at the TTL for an idle session', () => {
    expect(computeFreshnessView(NOW, NOW - FRESHNESS_TTL_MS, false)).toBeNull();
    expect(computeFreshnessView(NOW, NOW - (FRESHNESS_TTL_MS + 60_000), false)).toBeNull();
  });

  it('a STALE anchor (the pre-fix symptom) has already counted most of the way down', () => {
    // Contrast with the fresh-anchor case: if lastActiveAt were pinned to a much
    // earlier turn boundary while the session was actually still warm, the leaf
    // would (wrongly) read nearly cold — the exact false-stale the fix prevents.
    const view = computeFreshnessView(NOW, NOW - (4 * 60 * 1000 + 30_000), false); // 4m30s old
    expect(view).not.toBeNull();
    expect(view!.title).toBe('Prompt cache warm · ~0m 30s of warmth left');
  });
});

describe('edge cases', () => {
  it('a stale anchor past the TTL is hidden even so (idle)', () => {
    expect(computeFreshnessView(NOW, NOW - 10 * 60 * 1000, false)).toBeNull();
  });

  it('clock skew (lastActiveAt in the future) clamps to full-green, not an invalid color', () => {
    const view = computeFreshnessView(NOW, NOW + 5_000, false);
    expect(view).not.toBeNull();
    expect(view!.color).toBe(FULL_GREEN); // frac clamped to 0 (never a negative hue)
    // remainMs is not upper-clamped (matches the original component), so a future
    // anchor reads a touch over the full window — a harmless degenerate case.
    expect(view!.title).toMatch(/^Prompt cache warm · ~5m \d+s of warmth left$/);
  });
});
