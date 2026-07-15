import { describe, it, expect } from 'vitest';
import { costForUsage, latestRate } from '../../lib/pricing';

describe('costForUsage — cache TTL pricing', () => {
  it('reproduces Anthropic total_cost_usd exactly for a 1h cache write', () => {
    // Captured from the SDK result message (scripts/compare-cost.ts):
    //   opus-4-8, input=2 output=4, cache_creation 1h=23205, cr=0 -> $0.232160
    const { cost, priced } = costForUsage('claude-opus-4-8', {
      input: 2, output: 4, cacheWrite5m: 0, cacheWrite1h: 23205, cacheRead: 0,
    });
    expect(priced).toBe(true);
    expect(cost).toBeCloseTo(0.232160, 6);
  });

  it('bills 1h cache at 2x input and 5m at 1.25x (the bug: everything at 5m)', () => {
    const per = (u: Parameters<typeof costForUsage>[1]) => costForUsage('claude-opus-4-8', u).cost;
    const only5m = per({ input: 0, output: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0, cacheRead: 0 });
    const only1h = per({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000, cacheRead: 0 });
    expect(only5m).toBeCloseTo(6.25, 6); // 1.25 * $5 input
    expect(only1h).toBeCloseTo(10, 6);   // 2.00 * $5 input
    // The old code priced 1h tokens at the 5m rate — 37.5% low on the write.
    expect(only5m / only1h).toBeCloseTo(0.625, 6);
  });

  it('uses the derived cache rates from the model rate table', () => {
    const r = latestRate('claude-opus-4-8')!;
    expect(r).toMatchObject({ input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
  });

  it('returns unpriced (cost 0) for unknown models', () => {
    const { cost, priced } = costForUsage('gpt-4o', {
      input: 100, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    });
    expect(priced).toBe(false);
    expect(cost).toBe(0);
  });
});
