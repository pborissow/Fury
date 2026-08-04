import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseModel, groupByFamily, familyRank, readOAuthToken, type CatalogEntry } from '../../lib/modelCatalog';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

describe('parseModel — legacy 3.x version-first shapes (F4)', () => {
  it('parses a version-first display name ("Claude 3.5 Sonnet")', () => {
    const e = parseModel({ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet', created_at: '2024-10-22T00:00:00Z' })!;
    expect(e).toMatchObject({ family: 'sonnet', versionLabel: '3.5', id: 'claude-3-5-sonnet-20241022' });
  });
  it('parses a version-first WIRE id when display_name is absent', () => {
    const e = parseModel({ id: 'claude-3-5-sonnet-20241022' })!;
    expect(e).toMatchObject({ family: 'sonnet', versionLabel: '3.5' });
  });
  it('parses a major-only 3.x id ("Claude 3 Opus")', () => {
    const e = parseModel({ id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus' })!;
    expect(e).toMatchObject({ family: 'opus', versionLabel: '3' });
  });
  it('does NOT capture the dated snapshot as the version (the F4 bug)', () => {
    const e = parseModel({ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' })!;
    expect(e.versionLabel).not.toBe('20241022');
  });
});

describe('groupByFamily — legacy 3.x sorts BELOW current models (F4)', () => {
  it('places Sonnet 3.5 last in the family, below 5 / 4.6 / 4.5', () => {
    const sample = [
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-01T00:00:00Z' },
      { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' },
      { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet', created_at: '2024-10-22T00:00:00Z' },
    ];
    const entries = sample.map(m => parseModel(m)).filter((e): e is CatalogEntry => e !== null);
    const sonnet = groupByFamily(entries).find(g => g.family === 'sonnet')!;
    expect(sonnet.versions.map(v => v.versionLabel)).toEqual(['5', '4.6', '4.5', '3.5']);
    expect(sonnet.versions[0].versionLabel, 'legacy 3.x is NOT surfaced first').not.toBe('3.5');
  });
});

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

describe('readOAuthToken', () => {
  const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc123' } });
  const origPlatform = process.platform;
  const setPlatform = (p: string) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

  afterEach(() => {
    setPlatform(origPlatform);
    vi.mocked(execFileSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it('reads the token from the macOS Keychain on darwin', () => {
    setPlatform('darwin');
    vi.mocked(execFileSync).mockReturnValue(CREDS as any);
    expect(readOAuthToken()).toBe('tok-abc123');
    expect(execFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      expect.any(Object),
    );
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('falls back to the credentials file when the Keychain lookup fails on darwin', () => {
    setPlatform('darwin');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('item not found'); });
    vi.mocked(readFileSync).mockReturnValue(CREDS as any);
    expect(readOAuthToken()).toBe('tok-abc123');
    expect(readFileSync).toHaveBeenCalled();
  });

  it('reads the credentials file directly on non-darwin platforms', () => {
    setPlatform('linux');
    vi.mocked(readFileSync).mockReturnValue(CREDS as any);
    expect(readOAuthToken()).toBe('tok-abc123');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('returns null when no token can be found anywhere', () => {
    setPlatform('linux');
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readOAuthToken()).toBeNull();
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
