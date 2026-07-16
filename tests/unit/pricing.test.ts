import { describe, it, expect } from 'vitest';
import { cacheRewriteCost, costForUsage, latestRate, modelTierRank } from '../../lib/pricing';

describe('modelTierRank — picker ordering', () => {
  it('orders the catalog most-capable-first: fable, opus, sonnet, haiku', () => {
    // The real catalog's resolvedModel values, deliberately shuffled — the CLI
    // ships them as default/opus/fable/sonnet/haiku, which is not the order we
    // want to render.
    const shuffled = [
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-fable-5',
    ];
    const sorted = [...shuffled].sort((a, b) => modelTierRank(a) - modelTierRank(b));
    expect(sorted).toEqual([
      'claude-fable-5',
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('sorts unknown families last without disturbing their order', () => {
    const rank = (m: string) => modelTierRank(m);
    expect(rank('claude-fable-5')).toBeLessThan(rank('claude-opus-4-8'));
    expect(rank('claude-opus-4-8')).toBeLessThan(rank('claude-sonnet-5'));
    expect(rank('claude-sonnet-5')).toBeLessThan(rank('claude-haiku-4-5'));
    expect(rank('some-future-model')).toBeGreaterThan(rank('claude-haiku-4-5'));
  });
});

describe('cacheRewriteCost — the model-switch quote', () => {
  it('prices the re-write at the 1h TTL, not 5m', () => {
    // Claude Code writes at the 1h TTL (verified: 1,026/1,026 TTL-split rows in
    // usage_events are 1h; the sibling test above already calls all-5m "the
    // bug"). 400k on Opus 4.8 = 0.4 * $10/Mtok (2x the $5 input) = $4.00.
    // At the 5m rate this quotes $2.50 — 1.6x low, and softest on exactly the
    // big sessions the confirm dialog exists to warn about.
    expect(cacheRewriteCost('claude-opus-4-8', 400_000)).toBeCloseTo(4.0, 6);
    expect(cacheRewriteCost('claude-haiku-4-5', 400_000)).toBeCloseTo(0.8, 6);
  });

  it('returns null rather than quoting $0 when the model has no published rate', () => {
    // Bedrock ids keep their `us.` prefix through normalizeModelId, so they miss
    // the table. Callers must omit the cost line, not claim it's free.
    expect(cacheRewriteCost('us.anthropic.claude-sonnet-4-6', 400_000)).toBeNull();
    expect(cacheRewriteCost('claude-opus-4-8', 0)).toBeNull();
    expect(cacheRewriteCost(null, 400_000)).toBeNull();
  });
});

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
