/**
 * Pure path helpers for the Files tab (lib/treePaths.ts). Covers the folder
 * "has changes" prefix test — including the sibling-prefix trap and Windows
 * separators — and the search match rule.
 * (docs/ticket-filetree-lazy-load-and-watcher-dedup.md §5.3/§5.4)
 */
import { describe, it, expect } from 'vitest';
import { dirHasChange, matchesSearch } from '../../lib/treePaths';

describe('dirHasChange', () => {
  it('true when a changed file lives inside the directory', () => {
    expect(dirHasChange('/a/b', { '/a/b/file.ts': 'M' })).toBe(true);
    expect(dirHasChange('/a/b', { '/a/b/deep/nested/x.ts': '?' })).toBe(true);
  });

  it('false when nothing changed under the directory', () => {
    expect(dirHasChange('/a/b', { '/a/c/file.ts': 'M' })).toBe(false);
    expect(dirHasChange('/a/b', {})).toBe(false);
  });

  it('does NOT match a sibling that merely shares the name as a prefix', () => {
    // /a/b must not match /a/bc/x — the trailing-separator guard.
    expect(dirHasChange('/a/b', { '/a/bc/x.ts': 'M' })).toBe(false);
    expect(dirHasChange('/a/b', { '/a/bcd': 'M' })).toBe(false);
  });

  it('does not treat the directory path itself as a change', () => {
    // A key equal to the dir (no child) is not "a change inside it".
    expect(dirHasChange('/a/b', { '/a/b': 'M' })).toBe(false);
  });

  it('handles a trailing separator on the directory path', () => {
    expect(dirHasChange('/a/b/', { '/a/b/file.ts': 'M' })).toBe(true);
    expect(dirHasChange('/a/b/', { '/a/bc/x.ts': 'M' })).toBe(false);
  });

  it('normalizes Windows separators on both sides', () => {
    expect(dirHasChange('C:\\a\\b', { 'C:\\a\\b\\file.ts': 'M' })).toBe(true);
    expect(dirHasChange('C:\\a\\b', { 'C:\\a\\bc\\x.ts': 'M' })).toBe(false);
    // mixed input
    expect(dirHasChange('C:/a/b', { 'C:\\a\\b\\file.ts': 'M' })).toBe(true);
  });

  it('false for a null/undefined status map', () => {
    expect(dirHasChange('/a/b', null)).toBe(false);
    expect(dirHasChange('/a/b', undefined)).toBe(false);
  });
});

describe('matchesSearch', () => {
  it('case-insensitive prefix match on the basename', () => {
    expect(matchesSearch('Component.tsx', 'comp')).toBe(true);
    expect(matchesSearch('component.tsx', 'COMP')).toBe(true);
    expect(matchesSearch('README.md', 'read')).toBe(true);
  });
  it('false when the name does not start with the query', () => {
    expect(matchesSearch('Component.tsx', 'onent')).toBe(false);
    expect(matchesSearch('a.ts', 'b')).toBe(false);
  });
});
