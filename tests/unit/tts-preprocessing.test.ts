import { describe, it, expect } from 'vitest';
import { prepareTextForSpeech } from '@/lib/tts';

describe('prepareTextForSpeech', () => {
  it('strips code blocks', () => {
    const input = 'Hello ```js\nconsole.log("x")\n``` world';
    const result = prepareTextForSpeech(input);
    expect(result).toContain('Hello');
    expect(result).toContain('code block omitted');
    expect(result).toContain('world');
    expect(result).not.toContain('console.log');
  });

  it('strips markdown tables', () => {
    const input = 'Data:\n| A | B |\n|---|---|\n| 1 | 2 |';
    const result = prepareTextForSpeech(input);
    expect(result).toContain('Data');
    expect(result).not.toContain('|');
  });

  it('strips heading markers', () => {
    expect(prepareTextForSpeech('## Title')).toBe('Title');
    expect(prepareTextForSpeech('### Sub Heading')).toBe('Sub Heading');
  });

  it('strips bold markers', () => {
    expect(prepareTextForSpeech('This is **important** stuff')).toBe('This is important stuff');
  });

  it('keeps link labels, drops URLs', () => {
    expect(prepareTextForSpeech('See [docs](https://example.com) here')).toBe('See docs here');
  });

  it('shortens file paths in backticks to filename without extension', () => {
    expect(prepareTextForSpeech('`src/lib/tts.ts`')).toBe('tts');
    expect(prepareTextForSpeech('`components/ChatTab.tsx`')).toBe('ChatTab');
  });

  it('strips backticks from inline code', () => {
    expect(prepareTextForSpeech('Use `useState` hook')).toBe('Use useState hook');
  });

  it('shortens bare Windows paths', () => {
    expect(prepareTextForSpeech('File at C:\\Users\\petya\\file.txt here')).toBe('File at file here');
  });

  it('strips bullet list markers', () => {
    const input = '- item one\n- item two';
    const result = prepareTextForSpeech(input);
    expect(result).toContain('item one');
    expect(result).toContain('item two');
    expect(result).not.toContain('-');
  });

  it('strips numbered list markers', () => {
    const input = '1. first\n2. second';
    const result = prepareTextForSpeech(input);
    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result).not.toMatch(/^\d+\./);
  });

  it('converts line breaks to sentence pauses', () => {
    const result = prepareTextForSpeech('Line one\nLine two');
    expect(result).toBe('Line one. Line two');
  });

  it('converts paragraph breaks to sentence pauses', () => {
    const result = prepareTextForSpeech('Paragraph one\n\nParagraph two');
    expect(result).toBe('Paragraph one. Paragraph two');
  });

  it('collapses consecutive periods', () => {
    const result = prepareTextForSpeech('End.\n\nStart');
    expect(result).not.toContain('..');
  });

  it('collapses extra whitespace', () => {
    const result = prepareTextForSpeech('Too   many    spaces');
    expect(result).toBe('Too many spaces');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(prepareTextForSpeech('   ')).toBe('');
  });

  it('returns only a period for newline-only input', () => {
    expect(prepareTextForSpeech('\n\n')).toBe('.');
  });

  it('handles a mixed real-world response', () => {
    const input = [
      '## Summary',
      '',
      'Here is **bold** and `inline` code.',
      '',
      '- First item',
      '- Second item',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'See [link](https://example.com) for `lib/tts.ts` details.',
    ].join('\n');

    const result = prepareTextForSpeech(input);
    expect(result).toContain('Summary');
    expect(result).toContain('bold');
    expect(result).toContain('inline');
    expect(result).toContain('First item');
    expect(result).toContain('code block omitted');
    expect(result).toContain('link');
    expect(result).toContain('tts');
    expect(result).not.toContain('```');
    expect(result).not.toContain('**');
    expect(result).not.toContain('https');
    expect(result).not.toContain('.ts');
  });
});
