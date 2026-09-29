/** formatModelName — the composer status label's model name (moved out of ChatTab). */
import { describe, it, expect } from 'vitest';
import { formatModelName } from '../../lib/formatModelName';

describe('formatModelName', () => {
  it('formats two-segment versions', () => {
    expect(formatModelName('claude-opus-4-8')).toBe('Claude Opus 4.8');
  });
  it('formats one-segment versions (minor segment is optional)', () => {
    expect(formatModelName('claude-sonnet-5')).toBe('Claude Sonnet 5');
  });
  it('ignores a context-window suffix', () => {
    expect(formatModelName('claude-opus-4-8[1m]')).toBe('Claude Opus 4.8');
  });
  it('returns null for missing or unrecognized ids', () => {
    expect(formatModelName(null)).toBeNull();
    expect(formatModelName('')).toBeNull();
    expect(formatModelName('gpt-4o')).toBeNull();
  });
});
