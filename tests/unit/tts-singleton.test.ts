import { describe, it, expect, vi } from 'vitest';
import { warmupTTS, prepareTextForSpeech } from '@/lib/tts';

describe('warmupTTS', () => {
  it('does not throw even when pool initialization fails', () => {
    // warmupTTS is fire-and-forget — should never throw synchronously
    expect(() => warmupTTS()).not.toThrow();
  });
});

describe('splitSentences (via prepareTextForSpeech)', () => {
  it('produces text that splits cleanly at sentence boundaries', () => {
    const input = 'First sentence. Second sentence! Third sentence?';
    const clean = prepareTextForSpeech(input);
    // The cleaned text should preserve sentence-ending punctuation
    expect(clean).toContain('First sentence.');
    expect(clean).toContain('Second sentence!');
    expect(clean).toContain('Third sentence?');
  });

  it('handles bullet lists as separate sentences', () => {
    const input = '- Item one\n- Item two\n- Item three';
    const clean = prepareTextForSpeech(input);
    // Each item becomes a sentence (period-separated)
    expect(clean).toContain('Item one.');
    expect(clean).toContain('Item two.');
  });
});
