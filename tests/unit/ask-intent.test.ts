/**
 * Keyword vs question detection + the keyword-fallback residue
 * (lib/askIntent.ts, docs/ticket-ask-search.md §5). The detector errs toward
 * keyword: a false "question" spends a model call on Enter; a false
 * "keyword" only means clicking Ask.
 */
import { describe, it, expect } from 'vitest';
import { isQuestion, questionResidue, wordsOf } from '../../lib/askIntent';

describe('isQuestion', () => {
  it.each([
    // The ticket's own example.
    'can you help me find the sessions where we worked on the file tree in fury?',
    'where did we fix the tree?',
    'what is bm25?',                               // ? turns 3 words into a question
    'find sessions about the file tree',
    'show me the stats tab work',
    'which of those were about the tree watcher',
    'the one where we fixed renaming',             // no cue, but reads as prose
    'did we ever change lib/db.ts?',               // code tokens don't veto a real question
    '  How do we reap orphaned processes  ',
  ])('question: %s', (q) => {
    expect(isQuestion(q)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'file tree',
    'find tree',                                   // cue but only 2 words
    'what is bm25',                                // cue, 3 words, no ?
    'tree?',
    'lib/db.ts',
    '"where did we fix the tree?"',                // quoted = exact phrase search
    "'the one where we fixed it'",
    'file tree watcher sse connection leak',       // 6 words, no filler: keywords
    'runSearch clampLimit MAX_TOTAL_HITS',
    'stealth sessions hidden',
  ])('keyword: %s', (q) => {
    expect(isQuestion(q)).toBe(false);
  });
});

describe('wordsOf', () => {
  it('strips surrounding punctuation but keeps paths, dots, dashes, underscores', () => {
    expect(wordsOf('  "where", (did) we fix lib/db.ts? plan-fury_home!  ')).toEqual(
      ['where', 'did', 'we', 'fix', 'lib/db.ts', 'plan-fury_home'],
    );
  });
});

describe('questionResidue', () => {
  const projects = ['/Users/me/Documents/JavaScript/Fury', '/Users/me/Projects/garden-planner'];

  it('keeps the subject, turns a project name into a filter', () => {
    expect(questionResidue('can you help me find the sessions where we worked on the file tree in fury?', projects))
      .toEqual({ terms: ['file', 'tree'], project: '/Users/me/Documents/JavaScript/Fury' });
  });

  it('works without projects and dedupes terms', () => {
    expect(questionResidue('when did we add the cost charts to the stats tab? cost charts!'))
      .toEqual({ terms: ['add', 'cost', 'charts', 'stats', 'tab'], project: null });
  });

  it('can leave nothing (pure boilerplate)', () => {
    expect(questionResidue('can you find the session we worked on yesterday?')).toEqual({ terms: [], project: null });
  });
});
