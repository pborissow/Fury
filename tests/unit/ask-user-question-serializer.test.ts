import { describe, it, expect } from 'vitest';
import {
  buildProseAnswer,
  buildStructuredAnswers,
  type AskQuestion,
  type AskDialogState,
} from '../../lib/askUserQuestion';

/**
 * The two answer shapes, side by side.
 *
 * PROSE feeds the CLI backend, which cannot answer the tool at all — the answer
 * is re-sent as a fresh user turn, so it has to read as English.
 * STRUCTURED feeds the SDK backend, where the tool call is still parked and the
 * answer goes back as its own `updatedInput.answers`, keyed by QUESTION TEXT
 * with multi-select comma-joined (AskUserQuestionOutput's contract).
 *
 * Both read the same three dialog Maps, so they can drift apart silently; these
 * tests pin each shape independently.
 */

const state = (
  selections: Record<number, number[]> = {},
  useOther: Record<number, boolean> = {},
  otherText: Record<number, string> = {},
): AskDialogState => ({
  selections: new Map(Object.entries(selections).map(([k, v]) => [Number(k), new Set(v)])),
  useOther: new Map(Object.entries(useOther).map(([k, v]) => [Number(k), v])),
  otherText: new Map(Object.entries(otherText).map(([k, v]) => [Number(k), v])),
});

const LIB: AskQuestion = {
  question: 'Which library should we use?',
  header: 'Library',
  multiSelect: false,
  options: [{ label: 'date-fns' }, { label: 'moment' }],
};

const FEATURES: AskQuestion = {
  question: 'Which features do you want?',
  header: 'Features',
  multiSelect: true,
  options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
};

describe('buildStructuredAnswers (SDK path)', () => {
  it('keys by question TEXT, not header or index', () => {
    const { answers } = buildStructuredAnswers([LIB], state({ 0: [0] }));
    expect(answers).toEqual({ 'Which library should we use?': 'date-fns' });
    // The header is a UI chip; keying by it would silently not match the tool's
    // own output contract.
    expect(Object.keys(answers)).not.toContain('Library');
  });

  it('comma-joins a multi-select', () => {
    const { answers } = buildStructuredAnswers([FEATURES], state({ 0: [0, 1] }));
    expect(answers['Which features do you want?']).toBe('Auth, Billing');
  });

  it('"Other" alone becomes the answer string itself', () => {
    const { answers, annotations } = buildStructuredAnswers(
      [LIB],
      state({}, { 0: true }, { 0: 'luxon' }),
    );
    expect(answers['Which library should we use?']).toBe('luxon');
    expect(annotations).toBeUndefined();
  });

  it('"Other" ALONGSIDE selections keeps labels as the answer and moves free text to annotations', () => {
    // The answer must stay a clean value the model can match against the options
    // it offered — free text belongs in notes, not smuggled into the answer.
    const { answers, annotations } = buildStructuredAnswers(
      [FEATURES],
      state({ 0: [0, 2] }, { 0: true }, { 0: 'and dark mode please' }),
    );
    expect(answers['Which features do you want?']).toBe('Auth, Search');
    expect(annotations).toEqual({
      'Which features do you want?': { notes: 'and dark mode please' },
    });
  });

  it('omits an unanswered question rather than sending an empty string', () => {
    // "" would read as a real answer to the model.
    const { answers } = buildStructuredAnswers([LIB, FEATURES], state({ 0: [1] }));
    expect(answers).toEqual({ 'Which library should we use?': 'moment' });
    expect(answers).not.toHaveProperty('Which features do you want?');
  });

  it('ignores "Other" text when the Other toggle is off', () => {
    // Stale text left in the box after untoggling must not leak into the answer.
    const { answers } = buildStructuredAnswers([LIB], state({ 0: [0] }, { 0: false }, { 0: 'stale' }));
    expect(answers['Which library should we use?']).toBe('date-fns');
  });

  it('answers every question independently across a multi-question dialog', () => {
    const { answers } = buildStructuredAnswers([LIB, FEATURES], state({ 0: [0], 1: [1, 2] }));
    expect(answers).toEqual({
      'Which library should we use?': 'date-fns',
      'Which features do you want?': 'Billing, Search',
    });
  });
});

describe('buildProseAnswer (CLI path)', () => {
  it('renders a single selection', () => {
    expect(buildProseAnswer([LIB], state({ 0: [0] }))).toBe('I choose: date-fns');
  });

  it('renders "Other" alone', () => {
    expect(buildProseAnswer([LIB], state({}, { 0: true }, { 0: 'luxon' }))).toBe('My answer: luxon');
  });

  it('renders selection + "Other" as additional input', () => {
    expect(buildProseAnswer([FEATURES], state({ 0: [0] }, { 0: true }, { 0: 'plus SSO' }))).toBe(
      'I choose: Auth. Additional input: plus SSO',
    );
  });

  it('prefixes with the header ONLY when there are multiple questions', () => {
    expect(buildProseAnswer([LIB], state({ 0: [0] }))).not.toContain('For "Library"');
    expect(buildProseAnswer([LIB, FEATURES], state({ 0: [0], 1: [1] }))).toBe(
      'For "Library": I choose: date-fns\nFor "Features": I choose: Billing',
    );
  });
});
