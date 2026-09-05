import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectUsageLimit } from '@/lib/providerSwitch';

describe('detectUsageLimit', () => {
  it('returns false for normal text', () => {
    expect(detectUsageLimit('hello world').detected).toBe(false);
    expect(detectUsageLimit('').detected).toBe(false);
  });

  it('detects "out of extra usage" message and captures the reset time', () => {
    const text = "you're out of extra usage. resets 12pm (America/New_York)";
    const r = detectUsageLimit(text);
    expect(r.detected).toBe(true);
    expect(r.resetTimeRaw).toContain('12pm');
    expect(typeof r.resetTimeMs).toBe('number');
  });

  it('detects "hit your limit" wording (synthetic assistant payload) and captures the reset time', () => {
    // This is the actual on-the-wire format emitted by Claude Code as of 2026.
    const text = "You've hit your limit · resets 5:40pm (America/New_York)";
    const r = detectUsageLimit(text);
    expect(r.detected).toBe(true);
    expect(r.resetTimeRaw).toContain('5:40pm');
    expect(r.resetTimeRaw).toContain('America/New_York');
    expect(typeof r.resetTimeMs).toBe('number');
    // Reset time must be in the future (the parser bumps to tomorrow if
    // the computed time is already past).
    expect(r.resetTimeMs!).toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------
  // parseResetTime — numeric correctness across timezones and DST
  //
  // Regression for the original TZ math bug where `new Date(isoish)`
  // (which parses as runtime-local time) gave a result offset by
  // `2 × runtime_offset` from the correct UTC value. On an EDT runtime
  // a 4:50pm EDT reset got computed as 8:50pm EDT, scheduling the
  // auto-return 4 hours late.
  //
  // Each test pins `Date.now()` to an explicit "current" moment so the
  // assertion is deterministic regardless of when the tests run, and
  // asserts the *exact* expected epoch-ms.
  // -------------------------------------------------------------------

  describe('parseResetTime numeric correctness (via detectUsageLimit)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function pinNow(iso: string) {
      // Fake timers so both `Date.now()` and `new Date()` see the
      // pinned moment. The implementation uses `new Date()` to anchor
      // the "today in target tz" calculation, so spying only on
      // `Date.now()` would silently fall back to wall-clock time.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(iso));
    }

    it('America/New_York during EDT — 4:50pm resolves to 20:50Z (not 24:50Z)', () => {
      // 4:49:32 PM EDT, 28 seconds before the stated reset.
      pinNow('2026-05-11T20:49:32Z');
      const r = detectUsageLimit("You've hit your limit · resets 4:50pm (America/New_York)");
      expect(r.resetTimeMs).toBe(Date.UTC(2026, 4, 11, 20, 50, 0));
    });

    it('America/New_York during EST (winter) — 11:30am uses the -5 offset', () => {
      // 11:29am EST, January.
      pinNow('2026-01-15T16:29:00Z');
      const r = detectUsageLimit("You've hit your limit · resets 11:30am (America/New_York)");
      // 11:30am EST = 16:30 UTC.
      expect(r.resetTimeMs).toBe(Date.UTC(2026, 0, 15, 16, 30, 0));
    });

    it('America/Los_Angeles during PDT — 9:00pm uses the -7 offset', () => {
      // 8:59pm PDT.
      pinNow('2026-07-04T03:59:00Z');
      const r = detectUsageLimit("You've hit your limit · resets 9pm (America/Los_Angeles)");
      // 9:00pm PDT on 7/3 = 04:00 UTC on 7/4.
      expect(r.resetTimeMs).toBe(Date.UTC(2026, 6, 4, 4, 0, 0));
    });

    it('Europe/London during BST — 10:15am uses the +1 offset', () => {
      // 10:14am BST.
      pinNow('2026-06-15T09:14:00Z');
      const r = detectUsageLimit("You've hit your limit · resets 10:15am (Europe/London)");
      // 10:15am BST = 09:15 UTC.
      expect(r.resetTimeMs).toBe(Date.UTC(2026, 5, 15, 9, 15, 0));
    });

    it('UTC zone — clock time equals UTC time', () => {
      pinNow('2026-03-01T11:59:00Z');
      const r = detectUsageLimit("You've hit your limit · resets 12pm (UTC)");
      expect(r.resetTimeMs).toBe(Date.UTC(2026, 2, 1, 12, 0, 0));
    });

    it('rolls over to tomorrow when the computed reset is already in the past', () => {
      // Now is 5:00pm EDT. Reset says "4:50pm" (10 minutes ago today).
      pinNow('2026-05-11T21:00:00Z');
      const r = detectUsageLimit("You've hit your limit · resets 4:50pm (America/New_York)");
      const todayAt450 = Date.UTC(2026, 4, 11, 20, 50, 0); // already past
      expect(r.resetTimeMs).toBe(todayAt450 + 24 * 60 * 60_000);
    });
  });

  it('detects the bare "rate_limit" machine token emitted as a top-level error field', () => {
    const r = detectUsageLimit('rate_limit');
    expect(r.detected).toBe(true);
    // No reset time available from the token alone.
    expect(r.resetTimeMs).toBeUndefined();
  });

  it('detects rate-limit fallback patterns without a reset time', () => {
    for (const msg of [
      'Rate limit exceeded',
      'Usage limit reached',
      "you're out of extra usage",
      "you've hit your limit",
      'You have exceeded your current usage',
      'rate_limit',
      'usage-limit',
    ]) {
      const r = detectUsageLimit(msg);
      expect(r.detected, `pattern should match: ${msg}`).toBe(true);
    }
  });

  it('preserves the raw message on detection', () => {
    const r = detectUsageLimit('rate limit exceeded');
    expect(r.rawMessage).toBe('rate limit exceeded');
  });

  it('detects the per-model "reached your <model> limit" 429 wording (2026-09-04 repro)', () => {
    // Captured verbatim from a live terminal usage limit on Fable 5. Neither the
    // "hit your limit" nor the "usage limit" patterns match "reached your … limit",
    // so failover silently missed it until the dedicated pattern was added.
    const text =
      "You've reached your Fable limit. Switch to another model, or manage usage " +
      'credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.';
    expect(detectUsageLimit(text).detected).toBe(true);
    // The CLI's earlier phrasing carried a model number; both must match.
    expect(detectUsageLimit("You've reached your Fable 5 limit.").detected).toBe(true);
    expect(detectUsageLimit('You have reached your Opus limit for today.').detected).toBe(true);
  });

  it('does not match ordinary prose that merely contains "reached" or "limit"', () => {
    expect(detectUsageLimit('We reached the summit before the time limit.').detected).toBe(false);
    expect(detectUsageLimit('I reached out to the team about the rate.').detected).toBe(false);
  });

  it('does not fire on non-usage "reached your … limit" wordings (feeds auto-failover)', () => {
    // The "reached your … limit" pattern is anchored on a model family / usage
    // keyword precisely so these DON'T trip an unwanted Bedrock provider switch.
    expect(detectUsageLimit('You have reached your storage limit.').detected).toBe(false);
    expect(detectUsageLimit('You have reached your configured turn limit.').detected).toBe(false);
    expect(detectUsageLimit('reached your upload size limit').detected).toBe(false);
  });

  it('detects usage/plan-window "reached your … limit" wordings', () => {
    expect(detectUsageLimit('You have reached your usage limit.').detected).toBe(true);
    expect(detectUsageLimit("You've reached your weekly limit.").detected).toBe(true);
    expect(detectUsageLimit('reached your 5-hour limit').detected).toBe(true);
  });
});
