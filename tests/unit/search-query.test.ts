/**
 * lib/searchQuery: pure input → FTS MATCH / LIKE builder for /api/search
 * (docs/plan-search-tab.md §7). The invariant that matters most: NO user input
 * may produce a MATCH expression that FTS5 fails to parse — operators, quotes,
 * and metacharacters must all be neutralized by phrase-quoting.
 */
import { describe, it, expect } from 'vitest';
import { buildSearchQuery, buildLikeSnippet, MARK_OPEN, MARK_CLOSE } from '../../lib/searchQuery';

describe('buildSearchQuery', () => {
  it('returns null for empty / whitespace / slash-only input', () => {
    expect(buildSearchQuery('')).toBeNull();
    expect(buildSearchQuery('   ')).toBeNull();
    expect(buildSearchQuery('/')).toBeNull();
    expect(buildSearchQuery(' // ')).toBeNull();
  });

  it('quotes a single term as a prefix phrase', () => {
    expect(buildSearchQuery('clipboard')!.match).toBe('"clipboard"*');
  });

  it('ANDs multiple terms, prefix-starring only the last', () => {
    expect(buildSearchQuery('image clipboard feature')!.match).toBe(
      '"image" "clipboard" "feature"*',
    );
  });

  it('treats trailing whitespace as a completed word (no prefix star)', () => {
    expect(buildSearchQuery('clipboard ')!.match).toBe('"clipboard"');
  });

  it('turns a path into an adjacent-token phrase (split on / only)', () => {
    expect(buildSearchQuery('docs/plan-fury-home-migration.md')!.match).toBe(
      '"docs plan-fury-home-migration.md"*',
    );
  });

  it('keeps hyphen/underscore/dot terms as single tokens', () => {
    expect(buildSearchQuery('plan-fury_home.md')!.match).toBe('"plan-fury_home.md"*');
  });

  it('neutralizes FTS5 operators by phrase-quoting', () => {
    expect(buildSearchQuery('NEAR')!.match).toBe('"NEAR"*');
    expect(buildSearchQuery('a AND b OR c NOT d')!.match).toBe('"a" "AND" "b" "OR" "c" "NOT" "d"*');
    expect(buildSearchQuery('col:value')!.match).toBe('"col:value"*');
    expect(buildSearchQuery('star*')!.match).toBe('"star*"*');
    expect(buildSearchQuery('(paren)')!.match).toBe('"(paren)"*');
    expect(buildSearchQuery('caret^')!.match).toBe('"caret^"*');
  });

  it('escapes embedded double quotes by doubling', () => {
    expect(buildSearchQuery('say "hello"')!.match).toBe('"say" """hello"""*');
  });

  it('escapes LIKE wildcards in the fallback pattern', () => {
    const plan = buildSearchQuery('100% _done_ back\\slash')!;
    expect(plan.like).toBe('%100\\% \\_done\\_ back\\\\slash%');
  });

  it('preserves raw terms for LIKE-mode highlighting', () => {
    expect(buildSearchQuery('image clipboard')!.terms).toEqual(['image', 'clipboard']);
  });
});

describe('buildLikeSnippet', () => {
  it('wraps the first case-insensitive match with the shared markers', () => {
    const snip = buildLikeSnippet('The Image Pipeline works end to end', 'image pipeline');
    expect(snip).toBe(`The ${MARK_OPEN}Image Pipeline${MARK_CLOSE} works end to end`);
  });

  it('windows long content around the match with ellipses', () => {
    const content = 'x'.repeat(200) + ' NEEDLE ' + 'y'.repeat(200);
    const snip = buildLikeSnippet(content, 'needle');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain(`${MARK_OPEN}NEEDLE${MARK_CLOSE}`);
    expect(snip.length).toBeLessThan(160);
  });

  it('falls back to the head of the text when the needle is not found', () => {
    const snip = buildLikeSnippet('short content', 'zzz');
    expect(snip).toBe('short content');
    expect(buildLikeSnippet('a'.repeat(300), 'zzz').endsWith('…')).toBe(true);
  });
});
