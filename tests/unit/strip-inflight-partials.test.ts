/**
 * stripInFlightPartials — anchor vs fallback
 * (docs/ticket-inflight-partials-health-startedat.md, Part A criterion 4).
 *
 * The load-bearing case: a transcript `[completed turn A][in-flight partials]`
 * where the in-flight turn's prompt was folded into a tool_result (so it is NOT a
 * user message). With the real startedAt anchor, turn A must survive; the no-anchor
 * fallback wrongly walks back over it.
 */
import { describe, it, expect } from 'vitest';
import { stripInFlightPartials } from '../../lib/transcriptStrip';

type Msg = { role: 'user' | 'assistant'; content: string; timestamp?: string };
const ts = (ms: number) => new Date(ms).toISOString();

// A mid-turn prompt ("please continue") gets folded by the CLI into the next
// tool_result — array content the parser never emits as a user message — so the
// in-flight turn appears as a bare run of trailing assistant partials with NO
// preceding user message of its own.
const foldedMidTurn: Msg[] = [
  { role: 'user', content: 'do A', timestamp: ts(1000) },
  { role: 'assistant', content: 'A done', timestamp: ts(2000) }, // completed turn A
  { role: 'assistant', content: 'partial 1', timestamp: ts(5100) }, // in-flight (started 5000)
  { role: 'assistant', content: 'partial 2', timestamp: ts(5200) },
];

describe('stripInFlightPartials', () => {
  it('with a real startedAt, keeps an earlier COMPLETED turn (folded mid-turn prompt)', () => {
    const out = stripInFlightPartials(foldedMidTurn, 5000);
    expect(out.map((m) => m.content)).toEqual(['do A', 'A done']);
  });

  it('the fallback (startedAt=0) over-strips turn A — proving why the anchor matters', () => {
    const out = stripInFlightPartials(foldedMidTurn, 0);
    // Walks back over ALL trailing assistants → turn A's "A done" is wrongly cut.
    expect(out.map((m) => m.content)).toEqual(['do A']);
  });

  it('anchor cuts exactly at/after startedAt', () => {
    const messages: Msg[] = [
      { role: 'user', content: 'q', timestamp: ts(1000) },
      { role: 'assistant', content: 'old', timestamp: ts(2000) },
      { role: 'assistant', content: 'new', timestamp: ts(3000) },
    ];
    expect(stripInFlightPartials(messages, 3000).map((m) => m.content)).toEqual(['q', 'old']);
  });

  it('keeps everything when no message is at/after the anchor', () => {
    const messages: Msg[] = [
      { role: 'user', content: 'q', timestamp: ts(1000) },
      { role: 'assistant', content: 'a', timestamp: ts(2000) },
    ];
    expect(stripInFlightPartials(messages, 9_999_999).map((m) => m.content)).toEqual(['q', 'a']);
  });

  it('fallback keeps a normal (unfolded) turn boundary — trailing assistants only', () => {
    const messages: Msg[] = [
      { role: 'user', content: 'q1', timestamp: ts(1000) },
      { role: 'assistant', content: 'a1', timestamp: ts(2000) },
      { role: 'user', content: 'q2', timestamp: ts(3000) },
      { role: 'assistant', content: 'partial', timestamp: ts(4000) },
    ];
    expect(stripInFlightPartials(messages, 0).map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
  });
});
