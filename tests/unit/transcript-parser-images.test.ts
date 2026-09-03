/**
 * lib/transcriptParser image-part surfacing: array-form user turns (previously
 * dropped entirely — rendered as nothing) now emit both their text and their
 * image parts (inline data URL, fury-img://<hash> ref, or bare placeholder).
 */
import { describe, it, expect } from 'vitest';
import { parseTranscriptJsonl, extractUserContent } from '../../lib/transcriptParser';

const B64 = Buffer.from('hello').toString('base64');
const HASH = 'a'.repeat(64);

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseTranscriptJsonl image parts', () => {
  it('surfaces an inline image + text from an array-form user turn', () => {
    const jsonl = line({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
        ],
      },
    });
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('describe this');
    expect(messages[0].images).toHaveLength(1);
    expect(messages[0].images![0].dataUrl).toBe(`data:image/png;base64,${B64}`);
  });

  it('surfaces a fury-img ref placeholder as a hash image part', () => {
    const jsonl = line({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'earlier prompt' },
          { type: 'text', text: `[image previously analyzed: fury-img://${HASH}]` },
        ],
      },
    });
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages[0].content).toBe('earlier prompt');
    expect(messages[0].images).toEqual([{ hash: HASH }]);
  });

  it('surfaces a bare placeholder as a placeholder image part', () => {
    const jsonl = line({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[image previously analyzed]' }],
      },
    });
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
    expect(messages[0].images).toEqual([{ placeholder: true }]);
  });

  it('does NOT create a bubble for a pure tool_result delivery', () => {
    const jsonl = [
      line({ type: 'assistant', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-01-01T00:00:00Z' }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'result' }] }] }, timestamp: '2026-01-01T00:00:01Z' }),
    ].join('\n');
    const { messages } = parseTranscriptJsonl(jsonl);
    // Only the assistant message — the tool_result must not render as a user turn.
    expect(messages.filter(m => m.role === 'user')).toHaveLength(0);
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(1);
  });

  it('does NOT create a bubble for an array-form interrupt marker', () => {
    // The CLI writes "[Request interrupted by user]" as ARRAY content — it only
    // became reachable when the parser gained array support, and briefly
    // rendered as a spurious user bubble (and cleared pendingAskUserQuestion).
    const jsonl = line({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages).toHaveLength(0);
  });

  it('filters CLI-attached internal text blocks out of a real array turn', () => {
    // A real paste turn can carry an attached system reminder as an extra text
    // block; the reminder must not render as user text (mirrors the string
    // path's isInternalContent filter).
    const jsonl = line({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>internal</system-reminder>' },
          { type: 'text', text: 'real question' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
        ],
      },
    });
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('real question');
    expect(messages[0].images).toHaveLength(1);
  });
});

describe('extractUserContent', () => {
  it('separates text, inline images, refs, and placeholders; skips tool_result', () => {
    const { text, images } = extractUserContent([
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: B64 } },
      { type: 'text', text: `[image previously analyzed: fury-img://${HASH}]` },
      { type: 'text', text: '[image previously analyzed]' },
      { type: 'tool_result', tool_use_id: 'x', content: [] },
    ]);
    expect(text).toBe('a');
    expect(images).toEqual([
      { dataUrl: `data:image/webp;base64,${B64}` },
      { hash: HASH },
      { placeholder: true },
    ]);
  });
});
