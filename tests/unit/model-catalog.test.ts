import { describe, it, expect } from 'vitest';
import { parseModel, groupByFamily, familyRank, type CatalogEntry } from '../../lib/modelCatalog';

/** Real Models-API shapes captured from GET /v1/models on a Max account. */
const API_SAMPLE = [
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', created_at: '2026-05-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-06-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z', max_input_tokens: 200_000, max_tokens: 64_000, capabilities: { effort: { supported: true } } },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', max_input_tokens: 200_000, max_tokens: 64_000, capabilities: { effort: { supported: false } } },
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 64_000, capabilities: { effort: { supported: false } } },
  { id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z', max_input_tokens: 200_000, max_tokens: 32_000, capabilities: {} },
];

describe('parseModel', () => {
  it('parses family + version from display_name, keeping the wire id', () => {
    const e = parseModel(API_SAMPLE[4])!; // Sonnet 4.6
    expect(e).toMatchObject({
      id: 'claude-sonnet-4-6',
      family: 'sonnet',
      versionLabel: '4.6',
      displayName: 'Claude Sonnet 4.6',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      supportsEffort: true,
    });
  });

  it('keeps the dated-snapshot id verbatim (setModel accepts it)', () => {
    const e = parseModel(API_SAMPLE[7])!; // Haiku 4.5, dated id
    expect(e.id).toBe('claude-haiku-4-5-20251001');
    expect(e.family).toBe('haiku');
    expect(e.versionLabel).toBe('4.5');
    expect(e.supportsEffort).toBe(false);
  });

  it('reads a single-integer version (Sonnet 5, Fable 5)', () => {
    expect(parseModel(API_SAMPLE[0])!.versionLabel).toBe('5');
    expect(parseModel(API_SAMPLE[1])!).toMatchObject({ family: 'fable', versionLabel: '5' });
  });

  it('falls back to the id when display_name does not parse', () => {
    const e = parseModel({ id: 'claude-opus-4-9', display_name: 'Mystery Model' });
    expect(e).toMatchObject({ family: 'opus', versionLabel: '4.9', id: 'claude-opus-4-9' });
  });

  it('returns null for entries with no id or no recognizable family', () => {
    expect(parseModel({ display_name: 'Claude Opus 4.8' })).toBeNull(); // no id
    expect(parseModel({ id: 'gpt-4o', display_name: 'GPT-4o' })).toBeNull();
  });

  it('defaults capabilities.effort to false when absent', () => {
    expect(parseModel(API_SAMPLE[9])!.supportsEffort).toBe(false); // Opus 4.1, no capabilities
  });
});

describe('groupByFamily', () => {
  const entries = API_SAMPLE.map(m => parseModel(m)).filter((e): e is CatalogEntry => e !== null);
  const groups = groupByFamily(entries);

  it('orders families most-capable-first: fable, opus, sonnet, haiku', () => {
    expect(groups.map(g => g.family)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('orders versions within a family newest-first', () => {
    const opus = groups.find(g => g.family === 'opus')!;
    expect(opus.versions.map(v => v.versionLabel)).toEqual(['4.8', '4.7', '4.6', '4.5', '4.1']);
    const sonnet = groups.find(g => g.family === 'sonnet')!;
    expect(sonnet.versions.map(v => v.versionLabel)).toEqual(['5', '4.6', '4.5']);
  });

  it('exposes a human family label for the row header', () => {
    expect(groups.find(g => g.family === 'opus')!.displayName).toBe('Opus');
  });

  it('places every model into exactly one family', () => {
    const total = groups.reduce((n, g) => n + g.versions.length, 0);
    expect(total).toBe(entries.length);
    expect(entries.length).toBe(10);
  });
});

describe('familyRank', () => {
  it('ranks known families ahead of unknown ones', () => {
    expect(familyRank('fable')).toBeLessThan(familyRank('opus'));
    expect(familyRank('opus')).toBeLessThan(familyRank('sonnet'));
    expect(familyRank('sonnet')).toBeLessThan(familyRank('haiku'));
    expect(familyRank('whatever')).toBeGreaterThan(familyRank('haiku'));
  });
});
