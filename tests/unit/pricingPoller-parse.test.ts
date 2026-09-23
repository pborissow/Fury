import { describe, it, expect } from 'vitest';
import { parsePricingMarkdown } from '../../lib/pricingPoller';

/**
 * Locks the parser against the LIVE pricing-page format so a page-format shift
 * can't silently break the poller again (it did in 2026-09: the header moved
 * from title case "Base Input Tokens" to sentence case "Base input tokens",
 * and the poller logged "parsed 0 known models" for weeks). The header row and
 * representative data rows below are copied verbatim from
 * https://platform.claude.com/docs/en/about-claude/pricing.md.
 */

// Sentence-case header (the current format) + a mix of rows: tracked models,
// a footnoted cache cell (<sup>), a retired model with a markdown link + a
// parenthetical, and an untracked model (Fable 5.1) that must be skipped.
const CURRENT_PAGE = `
## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](https://x/y)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

Some trailing prose that ends the table.
`;

describe('parsePricingMarkdown — live page format (regression guard)', () => {
  it('parses tracked models from the sentence-case header', () => {
    const { rates } = parsePricingMarkdown(CURRENT_PAGE);

    // The bug was zero models parsed; assert we actually found the tracked ones.
    expect(rates.size).toBeGreaterThanOrEqual(5);

    expect(rates.get('claude-opus-4-8')).toMatchObject({ input: 5, output: 25 });
    expect(rates.get('claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(rates.get('claude-fable-5')).toMatchObject({ input: 10, output: 50 });
    expect(rates.get('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 });
  });

  it('reads explicit cache columns (not derived) including a footnoted cell', () => {
    const { rates } = parsePricingMarkdown(CURRENT_PAGE);
    // $0.50 cache-read for Opus 4.8 read straight from the column.
    expect(rates.get('claude-opus-4-8')).toMatchObject({
      cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5,
    });
    // Sonnet 5's cache-hit cell parses despite formatting; $0.20 read from col.
    expect(rates.get('claude-sonnet-5')?.cacheRead).toBeCloseTo(0.2, 6);
  });

  it('unwraps markdown links and parentheticals in the model name', () => {
    const { rates } = parsePricingMarkdown(CURRENT_PAGE);
    expect(rates.get('claude-opus-4-1')).toMatchObject({ input: 15, output: 75 });
  });

  it('parses Fable 5.1 including its footnoted 0.025x cache-read column', () => {
    const { rates } = parsePricingMarkdown(CURRENT_PAGE);
    // Now tracked (added to PRICING); the $0.25 cache-read is read straight from
    // the (footnoted) column, matching the constant's 0.025x multiplier.
    expect(rates.get('claude-fable-5-1')).toMatchObject({ input: 10, output: 50, cacheRead: 0.25 });
  });

  it('skips rows whose family is known but version is not tracked', () => {
    const md = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Opus 9.9 | $99 / MTok | $123.75 / MTok | $198 / MTok | $9.90 / MTok | $495 / MTok |
`;
    const { rates } = parsePricingMarkdown(md);
    expect(rates.has('claude-opus-9-9')).toBe(false);
  });

  it('still parses the legacy title-case header (backward compatible)', () => {
    const legacy = CURRENT_PAGE.replace(
      '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
      '| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |',
    );
    const { rates } = parsePricingMarkdown(legacy);
    expect(rates.get('claude-opus-4-8')).toMatchObject({ input: 5, output: 25 });
  });

  it('flags a model as ambiguous when two rows give different rates', () => {
    const dup = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
`;
    const { rates, ambiguous } = parsePricingMarkdown(dup);
    expect(ambiguous).toContain('claude-sonnet-5');
    expect(rates.has('claude-sonnet-5')).toBe(false);
  });
});
