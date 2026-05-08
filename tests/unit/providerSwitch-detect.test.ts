import { describe, it, expect } from 'vitest';
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
});
