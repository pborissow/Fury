/**
 * The SDK path resolves an AskUserQuestion tool call in place: the user's answer
 * comes back as a tool_result and is otherwise dropped from the display model, so
 * a detailed free-text "Other" answer would vanish from the UI entirely. The
 * parser recovers it from the tool_result (matched by tool_use id) and emits it
 * as a `role:'user'` message flagged `askAnswer`, so the renderer can surface it
 * as an in-turn intermediary alongside Claude's messages.
 */
import { describe, it, expect } from 'vitest';
import { parseTranscriptJsonl, extractAskAnswer, buildAskExchanges } from '../../lib/transcriptParser';

const line = (o: unknown) => JSON.stringify(o);
const userText = (uuid: string, ts: string, content: string) =>
  line({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content } });
const assistantBlocks = (uuid: string, ts: string, content: unknown[]) =>
  line({ type: 'assistant', uuid, timestamp: ts, message: { role: 'assistant', model: 'claude-fable-5', content } });
const toolResult = (uuid: string, ts: string, toolUseId: string, content: unknown) =>
  line({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });

describe('extractAskAnswer', () => {
  it('strips the "Your questions have been answered" wrapper', () => {
    expect(extractAskAnswer('Your questions have been answered: "Scope"="SDK answers, durable". You can now continue with these answers in mind.'))
      .toBe('"Scope"="SDK answers, durable"');
  });
  it('strips the "The user answered" wrapper and keeps long free-text verbatim', () => {
    const longAnswer = 'One combined change documented in a ticket in the docs/ folder. don\'t implement any code changes.';
    expect(extractAskAnswer(`The user answered: "How to sequence?"="${longAnswer}"`))
      .toBe(`"How to sequence?"="${longAnswer}"`);
  });
  it('handles array-form tool_result content', () => {
    expect(extractAskAnswer([{ type: 'text', text: 'The user answered: "Q"="A"' }])).toBe('"Q"="A"');
  });
  it('returns null for empty content', () => {
    expect(extractAskAnswer('')).toBeNull();
    expect(extractAskAnswer(undefined)).toBeNull();
  });
});

describe('buildAskExchanges', () => {
  it('returns one question/answer pair per question, in question order', () => {
    const out = buildAskExchanges({
      questions: [{ question: 'First?' }, { question: 'Second?' }],
      // Keys deliberately out of order — `questions` decides the order.
      answers: { 'Second?': 'B', 'First?': 'A' },
    });
    expect(out).toEqual([
      { question: 'First?', answer: 'A' },
      { question: 'Second?', answer: 'B' },
    ]);
  });

  it('lists the offered options under the question', () => {
    const out = buildAskExchanges({
      questions: [{ question: 'Scope?', options: [{ label: 'Durable' }, { label: 'Lightweight' }] }],
      answers: { 'Scope?': 'Durable' },
    });
    expect(out).toEqual([{ question: 'Scope?\n\n- Durable\n- Lightweight', answer: 'Durable' }]);
  });

  it('keeps quotes in questions intact (the string form made these ambiguous)', () => {
    const out = buildAskExchanges({
      questions: [{ question: 'Is "Reduce motion" on?' }],
      answers: { 'Is "Reduce motion" on?': "It's on" },
    });
    expect(out?.[0].question).toBe('Is "Reduce motion" on?');
  });

  it('preserves line breaks in multi-line questions and answers', () => {
    const out = buildAskExchanges({
      questions: [{ question: 'Line one\nline two' }],
      answers: { 'Line one\nline two': 'para 1\npara 2' },
    });
    expect(out).toEqual([{ question: 'Line one  \nline two', answer: 'para 1  \npara 2' }]);
  });

  it('appends annotation notes under the answer', () => {
    const out = buildAskExchanges({
      questions: [{ question: 'Q?' }],
      answers: { 'Q?': 'Option A' },
      annotations: { 'Q?': { notes: 'but only on weekdays' } },
    });
    expect(out?.[0].answer).toBe('Option A\n\nbut only on weekdays');
  });

  it('falls back to the tool_use questions for order and options', () => {
    const out = buildAskExchanges(
      { answers: { 'B?': 'b', 'A?': 'a' } },
      [{ question: 'A?', options: [{ label: 'a' }] }, { question: 'B?' }],
    );
    expect(out).toEqual([
      { question: 'A?\n\n- a', answer: 'a' },
      { question: 'B?', answer: 'b' },
    ]);
  });

  it('includes answered keys missing from the questions list', () => {
    expect(buildAskExchanges({ answers: { 'Orphan?': 'yes' } })).toEqual([{ question: 'Orphan?', answer: 'yes' }]);
  });

  it('returns null without structured answers, so the caller falls back', () => {
    expect(buildAskExchanges(undefined)).toBeNull();
    expect(buildAskExchanges({ questions: [] })).toBeNull();
    expect(buildAskExchanges({ answers: { 'Q?': '' } })).toBeNull();
  });
});

describe('parseTranscriptJsonl — AskUserQuestion answer recovery', () => {
  it('emits each question as Claude (askQuestion) followed by its answer as You (askAnswer)', () => {
    const jsonl = [
      userText('u1', '2026-09-29T10:00:00Z', 'pick'),
      assistantBlocks('a1', '2026-09-29T10:00:01Z', [
        { type: 'text', text: 'Question time.' },
        { type: 'tool_use', id: 'tu_ask1', name: 'AskUserQuestion', input: { questions: [
          { question: 'Scope?', options: [{ label: 'Durable' }, { label: 'Lightweight' }] },
          { question: 'Tests?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ] } },
      ]),
      line({
        type: 'user', uuid: 'tr1', timestamp: '2026-09-29T10:00:20Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ask1',
          content: 'Your questions have been answered: "Scope?"="Durable", "Tests?"="Yes". You can now continue with these answers in mind.' }] },
        // No `questions` here — exercises the fallback to the tool_use input.
        toolUseResult: { answers: { 'Scope?': 'Durable', 'Tests?': 'Yes' } },
      }),
      assistantBlocks('a2', '2026-09-29T10:00:25Z', [{ type: 'text', text: 'Done.' }]),
    ].join('\n');
    const { messages } = parseTranscriptJsonl(jsonl);
    const view = messages.map(m => [m.role, m.askQuestion ? 'Q' : m.askAnswer ? 'A' : '-', m.content]);
    expect(view).toEqual([
      ['user', '-', 'pick'],
      ['assistant', '-', 'Question time.'],
      ['assistant', 'Q', 'Scope?\n\n- Durable\n- Lightweight'],
      ['user', 'A', 'Durable'],
      ['assistant', 'Q', 'Tests?\n\n- Yes\n- No'],
      ['user', 'A', 'Yes'],
      ['assistant', '-', 'Done.'],
    ]);
    // Questions are stamped when they were asked; answers when they came back.
    const q = messages.find(m => m.askQuestion)!;
    const a = messages.find(m => m.askAnswer)!;
    expect(q.timestamp).toBe('2026-09-29T10:00:01Z');
    expect(a.timestamp).toBe('2026-09-29T10:00:20Z');
  });

  it('emits the answer as a user askAnswer message between preamble and continuation', () => {
    const jsonl = [
      userText('u1', '2026-09-23T10:00:00Z', 'help me pick an approach'),
      assistantBlocks('a1', '2026-09-23T10:00:01Z', [
        { type: 'text', text: 'Here are the options.' },
        { type: 'tool_use', id: 'tu_ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Scope', options: [] }] } },
      ]),
      toolResult('tr1', '2026-09-23T10:00:20Z', 'tu_ask1',
        'Your questions have been answered: "Scope"="SDK answers, durable". You can now continue with these answers in mind.'),
      assistantBlocks('a2', '2026-09-23T10:00:25Z', [{ type: 'text', text: 'Great, implementing now.' }]),
    ].join('\n');

    const { messages } = parseTranscriptJsonl(jsonl);

    const answer = messages.find(m => m.askAnswer);
    expect(answer).toBeDefined();
    expect(answer!.role).toBe('user');
    expect(answer!.content).toBe('"Scope"="SDK answers, durable"');

    // Chronological order: preamble (assistant) → answer (user) → continuation (assistant).
    const idxPreamble = messages.findIndex(m => m.content === 'Here are the options.');
    const idxAnswer = messages.findIndex(m => m.askAnswer);
    const idxCont = messages.findIndex(m => m.content === 'Great, implementing now.');
    expect(idxPreamble).toBeGreaterThanOrEqual(0);
    expect(idxPreamble).toBeLessThan(idxAnswer);
    expect(idxAnswer).toBeLessThan(idxCont);
  });

  it('ignores the CLI auto-error tool_result (real answer arrives as a normal user turn)', () => {
    const jsonl = [
      userText('u1', '2026-09-23T10:00:00Z', 'pick an approach'),
      assistantBlocks('a1', '2026-09-23T10:00:01Z', [
        { type: 'tool_use', id: 'tu_ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Scope', options: [] }] } },
      ]),
      // CLI --print auto-errors the tool; this must NOT be captured as an answer.
      line({ type: 'user', uuid: 'tr1', timestamp: '2026-09-23T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ask1', is_error: true, content: 'AskUserQuestion is not supported in --print mode' }] } }),
      // The real answer is re-sent as a fresh user turn — a normal "You" bubble.
      userText('u2', '2026-09-23T10:00:30Z', 'I choose: SDK answers, durable'),
      assistantBlocks('a2', '2026-09-23T10:00:35Z', [{ type: 'text', text: 'On it.' }]),
    ].join('\n');
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages.some(m => m.askAnswer)).toBe(false);
    // The prose answer is a normal, unflagged user message.
    const u = messages.find(m => m.content === 'I choose: SDK answers, durable');
    expect(u).toBeDefined();
    expect(u!.askAnswer).toBeUndefined();
  });

  it('does not fabricate an answer for an unrelated tool_result', () => {
    const jsonl = [
      userText('u1', '2026-09-23T10:00:00Z', 'read a file'),
      assistantBlocks('a1', '2026-09-23T10:00:01Z', [
        { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/x' } },
      ]),
      toolResult('tr1', '2026-09-23T10:00:02Z', 'tu_read', 'file contents'),
      assistantBlocks('a2', '2026-09-23T10:00:03Z', [{ type: 'text', text: 'Done.' }]),
    ].join('\n');
    const { messages } = parseTranscriptJsonl(jsonl);
    expect(messages.some(m => m.askAnswer)).toBe(false);
  });
});

describe('parseTranscriptJsonl — plan placement around an AskUserQuestion exchange', () => {
  it('anchors a plan written after the answer AFTER the answer, not between question and answer', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-09-29T10:00:00Z', slug: 'my-plan', message: { role: 'user', content: 'plan it' } }),
      assistantBlocks('a1', '2026-09-29T10:00:05Z', [
        { type: 'text', text: 'One question first.' },
        { type: 'tool_use', id: 'tu_ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Scope?', options: [] }] } },
      ]),
      line({
        type: 'user', uuid: 'tr1', timestamp: '2026-09-29T10:00:30Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ask1', content: 'The user answered: "Scope?"="Small"' }] },
        toolUseResult: { questions: [{ question: 'Scope?' }], answers: { 'Scope?': 'Small' } },
      }),
      // Plan written after the answer (tool-only entry, no text).
      assistantBlocks('a2', '2026-09-29T10:00:40Z', [
        { type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: '/Users/x/.claude/plans/my-plan.md', content: '# plan' } },
      ]),
      toolResult('tr2', '2026-09-29T10:00:41Z', 'tu_w', 'ok'),
      assistantBlocks('a3', '2026-09-29T10:00:50Z', [{ type: 'text', text: 'Plan is ready.' }]),
    ].join('\n');

    const { messages, planInsertAfter } = parseTranscriptJsonl(jsonl);
    expect(planInsertAfter).not.toBeNull();
    // The anchor is the answer — so question → answer → plan, in order.
    expect(messages[planInsertAfter!].askAnswer).toBe(true);
    expect(messages[planInsertAfter! - 1].askQuestion).toBe(true);
  });
});

