/**
 * Turn grouping + rewind-cut math. These lock the contracts that a review
 * caught regressions in: an AskUserQuestion answer is an in-turn intermediary
 * (never a turn boundary), a turn that ends on an answer still shows Claude's
 * question text, and rewinding after an answered question cuts at the right turn.
 */
import { describe, it, expect } from 'vitest';
import { groupTurns, findRewindCutIndex } from '../../lib/transcriptTurns';
import type { TranscriptMsg } from '../../lib/types';

const u = (content: string): TranscriptMsg => ({ role: 'user', content, timestamp: '' });
const a = (content: string): TranscriptMsg => ({ role: 'assistant', content, timestamp: '' });
const ans = (content: string): TranscriptMsg => ({ role: 'user', content, timestamp: '', askAnswer: true });
const q = (content: string): TranscriptMsg => ({ role: 'assistant', content, timestamp: '', askQuestion: true });

describe('groupTurns', () => {
  it('groups question → answer → continuation into one turn', () => {
    const turns = groupTurns([u('do X'), a('preamble + question'), ans('"Q"="A"'), a('final reply')]);
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.user?.content).toBe('do X');
    expect(t.assistant?.content).toBe('final reply');
    // Intermediaries read chronologically: preamble then answer.
    expect(t.intermediaries.map(m => m.content)).toEqual(['preamble + question', '"Q"="A"']);
    expect(t.intermediaries[1].askAnswer).toBe(true);
  });

  it('does not let an answer start a new turn', () => {
    const turns = groupTurns([u('T0'), a('q0'), ans('a0'), a('final0'), u('T1'), a('final1')]);
    expect(turns).toHaveLength(2);
    expect(turns[0].user?.content).toBe('T0');
    expect(turns[1].user?.content).toBe('T1');
  });

  it('keeps Claude\'s question text visible when a turn ends right after an answer', () => {
    // No assistant continuation (interrupted / errored / tool-only). The question
    // preamble must be promoted back to the visible bubble, not vanish.
    const turns = groupTurns([u('do X'), a('here is my question'), ans('"Q"="A"')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistant?.content).toBe('here is my question');
    // The answer remains reachable via the intermediary chip.
    expect(turns[0].intermediaries.map(m => m.content)).toEqual(['"Q"="A"']);
    // The promoted bubble keeps its flat index, so a Search deep link can still
    // scroll to it (the question preamble is message index 1 here).
    expect(turns[0].assistantIndex).toBe(1);
  });

  it('leaves assistant null when there is no assistant intermediary to promote', () => {
    // Text-less tool_use question: no preamble prose exists to promote, so the
    // turn legitimately has no Claude bubble. The answer is still preserved as an
    // intermediary — the renderer surfaces its chip on the You bubble in this case
    // (see TranscriptRenderer), so it is NOT invisible.
    const turns = groupTurns([u('do X'), ans('"Q"="A"')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistant).toBeNull();
    expect(turns[0].intermediaries.map(m => m.content)).toEqual(['"Q"="A"']);
  });
});

describe('groupTurns — question/answer exchanges', () => {
  it('keeps each question (Claude) and answer (You) together, in order, as intermediaries', () => {
    const turns = groupTurns([
      u('do X'), a('preamble'), q('Q1?'), ans('A1'), q('Q2?'), ans('A2'), a('final'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistant?.content).toBe('final');
    expect(turns[0].intermediaries.map(m => m.content)).toEqual(['preamble', 'Q1?', 'A1', 'Q2?', 'A2']);
    expect(turns[0].intermediaries.map(m => m.role)).toEqual(['assistant', 'assistant', 'user', 'assistant', 'user']);
  });

  it('promotes the preamble, not a question, when the turn ends on an answer', () => {
    const turns = groupTurns([u('do X'), a('preamble'), q('Q1?'), ans('A1')]);
    expect(turns[0].assistant?.content).toBe('preamble');
    expect(turns[0].assistantIndex).toBe(1);
    expect(turns[0].intermediaries.map(m => m.content)).toEqual(['Q1?', 'A1']);
  });

  it('never promotes a question: a text-less question turn keeps assistant null', () => {
    // The renderer then anchors the chip to the You bubble.
    const turns = groupTurns([u('do X'), q('Q1?'), ans('A1')]);
    expect(turns[0].assistant).toBeNull();
    expect(turns[0].intermediaries.map(m => m.content)).toEqual(['Q1?', 'A1']);
  });
});

describe('findRewindCutIndex', () => {
  // T0 contains an answer; rewinding to T2 must cut at T2's prompt, not T1's.
  const msgs: TranscriptMsg[] = [
    u('T0'),        // 0  turn 0
    a('q0'),        // 1
    ans('a0'),      // 2  answer — NOT a turn
    a('final0'),    // 3
    u('T1'),        // 4  turn 1
    a('final1'),    // 5
    u('T2'),        // 6  turn 2
    a('final2'),    // 7
  ];

  it('skips answers so the cut lands on the right turn', () => {
    expect(findRewindCutIndex(msgs, 2)).toBe(6); // T2's prompt, keeping T1
    expect(findRewindCutIndex(msgs, 1)).toBe(4); // T1's prompt
    expect(findRewindCutIndex(msgs, 0)).toBe(0);
  });

  it('returns -1 when the turn index is out of range', () => {
    expect(findRewindCutIndex(msgs, 3)).toBe(-1);
  });

  it('matches a naive user-count only when there are no answers', () => {
    const clean: TranscriptMsg[] = [u('T0'), a('r0'), u('T1'), a('r1')];
    expect(findRewindCutIndex(clean, 1)).toBe(2);
  });
});
