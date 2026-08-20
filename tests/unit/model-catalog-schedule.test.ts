import { describe, it, expect } from 'vitest';
import { computeNextRun } from '../../lib/modelCatalog';

/**
 * Scheduling / failure-backoff for the model-catalog poller.
 *
 * Regression: after a failed check, the next run was computed as
 *   Math.min(lastAt + FAILURE_BACKOFF_MS, lastOkAt + intervalMs)
 * to mean "retry soon, but no later than the regular cadence." Once the catalog
 * is overdue — the normal state for one that has been failing — `lastOkAt +
 * intervalMs` is in the PAST, so Math.min picked it, the delay collapsed to the
 * 5-second MIN_DELAY floor, and every failure retried in 5s. During the Claude
 * CLI's brief on-disk OAuth-token rotation, that produced a storm of 401s
 * (~12/min) instead of one failed check that quietly retries later.
 */

const DAY = 86_400_000;
const MIN_DELAY_MS = 5_000;
const BACKOFF_MS = 30 * 60 * 1000;
const now = Date.parse('2026-08-20T11:20:00.000Z');
const interval = 7 * DAY;

describe('computeNextRun', () => {
  it('checks ~now on first-ever boot (never checked)', () => {
    const r = computeNextRun({ now, lastAt: 0, lastOkAt: 0, lastFailed: false, intervalMs: interval });
    expect(r.delayMs).toBe(MIN_DELAY_MS); // floored, not instant
    expect(r.overdue).toBe(true);
  });

  it('schedules a full interval out after a success', () => {
    const lastOkAt = now - DAY; // succeeded yesterday
    const r = computeNextRun({ now, lastAt: lastOkAt, lastOkAt, lastFailed: false, intervalMs: interval });
    expect(r.delayMs).toBe(6 * DAY); // 7d cadence, 1d elapsed
    expect(r.overdue).toBe(false);
  });

  it('checks now when a past success is already overdue', () => {
    const lastOkAt = now - 10 * DAY; // last success 10d ago, interval 7d
    const r = computeNextRun({ now, lastAt: lastOkAt, lastOkAt, lastFailed: false, intervalMs: interval });
    expect(r.delayMs).toBe(MIN_DELAY_MS);
    expect(r.overdue).toBe(true);
  });

  it('THE FIX: a failure while overdue backs off, it does not hot-loop', () => {
    // Exactly the reported state: last success 17d ago, just failed 5s ago.
    const r = computeNextRun({
      now,
      lastAt: now - 5_000,
      lastOkAt: Date.parse('2026-08-03T18:02:20.000Z'),
      lastFailed: true,
      intervalMs: interval,
    });
    // Was 5s (the storm). Now ~30min from the last attempt.
    expect(r.delayMs).toBe(BACKOFF_MS - 5_000);
    expect(r.delayMs).toBeGreaterThan(MIN_DELAY_MS);
  });

  it('backs off even when the catalog has NEVER succeeded', () => {
    const r = computeNextRun({ now, lastAt: now - 1_000, lastOkAt: 0, lastFailed: true, intervalMs: interval });
    expect(r.delayMs).toBe(BACKOFF_MS - 1_000);
  });

  it('a fresh success followed by a failure still uses the short backoff, not the 7d cadence', () => {
    const lastOkAt = now - 60_000;      // succeeded a minute ago
    const r = computeNextRun({ now, lastAt: now, lastOkAt, lastFailed: true, intervalMs: interval });
    expect(r.delayMs).toBe(BACKOFF_MS); // 30min, not ~7d
  });

  it('never returns a delay below the MIN_DELAY floor', () => {
    // A failure recorded slightly in the "future" (clock skew) still floors cleanly.
    const r = computeNextRun({ now, lastAt: now + 10_000, lastOkAt: 0, lastFailed: true, intervalMs: interval });
    expect(r.delayMs).toBeGreaterThanOrEqual(MIN_DELAY_MS);
  });

  it('honors a shortened interval from settings', () => {
    const oneDay = 1 * DAY;
    const lastOkAt = now - 2 * DAY;
    const r = computeNextRun({ now, lastAt: lastOkAt, lastOkAt, lastFailed: false, intervalMs: oneDay });
    expect(r.overdue).toBe(true); // 2d since success, 1d interval → due
  });
});
