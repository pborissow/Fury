/**
 * The archive's `messages` table stores only role/content/timestamp, so the
 * AskUserQuestion flags (askQuestion / askAnswer) are lost there. Without them a
 * session loaded from the archive (its JSONL deleted by Claude Code) renders the
 * question as Claude's final reply and the answer as a new user prompt —
 * splitting the turn and shifting rewind numbering. loadTranscript restores the
 * flags from a reparse of raw_jsonl while keeping the archived rows (which carry
 * the spliced-in plan bubble raw_jsonl can't reproduce).
 *
 * Same harness as archive-status.test.ts: real initDb + archive path against a
 * throwaway DB via a mocked homedir.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptMessage } from '../../lib/transcriptParser';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'fury-archive-askflags-'));
mkdirSync(join(TEMP_HOME, '.claude'), { recursive: true });

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEMP_HOME };
});

const SESSION = 'archive-askflags-test-session';
const PROJECT = '/tmp/fury-archive-askflags-test';

const line = (o: unknown) => JSON.stringify(o);
// Preamble text and the tool_use share ONE assistant entry → the question row's
// timestamp equals the preamble's. A timestamp-keyed join would mis-flag.
const askConvo = [
  line({ type: 'user', uuid: 'u1', timestamp: '2026-09-29T10:00:00Z', message: { role: 'user', content: 'set things up' } }),
  line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-29T10:00:05Z', message: { role: 'assistant', model: 'claude', content: [
    { type: 'text', text: 'One decision first.' },
    { type: 'tool_use', id: 'tu_ask1', name: 'AskUserQuestion', input: { questions: [
      { question: 'Scope?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ] } },
  ] } }),
  line({
    type: 'user', uuid: 'tr1', timestamp: '2026-09-29T10:00:30Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ask1',
      content: 'Your questions have been answered: "Scope?"="Yes". You can now continue with these answers in mind.' }] },
    toolUseResult: { questions: [{ question: 'Scope?', options: [{ label: 'Yes' }, { label: 'No' }] }], answers: { 'Scope?': 'Yes' } },
  }),
  line({ type: 'assistant', uuid: 'a2', timestamp: '2026-09-29T10:00:40Z', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'All set.' }] } }),
  // A later ordinary prompt whose text equals the answer ("Yes") — must not
  // steal (or receive) the answer's flag.
  line({ type: 'user', uuid: 'u2', timestamp: '2026-09-29T10:01:00Z', message: { role: 'user', content: 'Yes' } }),
  line({ type: 'assistant', uuid: 'a3', timestamp: '2026-09-29T10:01:05Z', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Noted.' }] } }),
];

const strip = (ms: TranscriptMessage[]) => ms.map(({ role, content, timestamp }) => ({ role, content, timestamp }));

describe('restoreAskFlags', () => {
  it('flags by role+timestamp+content, without stealing from identical ordinary messages', async () => {
    const { restoreAskFlags } = await import('../../lib/transcriptArchiver');
    const reparsed: TranscriptMessage[] = [
      { role: 'user', content: 'Yes', timestamp: 't0' },                    // ordinary prompt
      { role: 'assistant', content: 'Q?', timestamp: 't1', askQuestion: true },
      { role: 'user', content: 'Yes', timestamp: 't2', askAnswer: true },   // same text, flagged
    ];
    const stored = strip(reparsed) as TranscriptMessage[];
    restoreAskFlags(stored, reparsed);
    expect(stored.map(m => [m.askQuestion ?? false, m.askAnswer ?? false])).toEqual([
      [false, false], [true, false], [false, true],
    ]);
  });

  it('pre-feature archive: a real prompt matching an unarchived answer is not flagged', async () => {
    // Rows archived before question/answer rows existed. The reparse has an
    // extra exchange early on whose answer text equals a LATER real prompt.
    const { restoreAskFlags } = await import('../../lib/transcriptArchiver');
    const { groupTurns } = await import('../../lib/transcriptTurns');
    const reparsed: TranscriptMessage[] = [
      { role: 'user', content: 'pick one', timestamp: '2026-09-29T10:00:00Z' },
      { role: 'assistant', content: 'Here are options.', timestamp: '2026-09-29T10:00:05Z' },
      { role: 'assistant', content: 'Proceed?\n\n- Yes\n- No', timestamp: '2026-09-29T10:00:05Z', askQuestion: true },
      { role: 'user', content: 'Yes', timestamp: '2026-09-29T10:00:30Z', askAnswer: true },
      { role: 'assistant', content: 'Done with A.', timestamp: '2026-09-29T10:00:40Z' },
      { role: 'user', content: 'Yes', timestamp: '2026-09-29T10:01:00Z' },
      { role: 'assistant', content: 'Shipping it.', timestamp: '2026-09-29T10:01:05Z' },
    ];
    // What the old archive holds: the same conversation minus the Q/A rows.
    const stored = strip(reparsed.filter(m => !m.askQuestion && !m.askAnswer)) as TranscriptMessage[];
    restoreAskFlags(stored, reparsed);

    expect(stored.some(m => m.askAnswer || m.askQuestion)).toBe(false);
    // Still two turns; the real "Yes" prompt isn't absorbed into the first.
    const turns = groupTurns(stored);
    expect(turns).toHaveLength(2);
    expect(turns[1].user?.content).toBe('Yes');
  });

  it('does not flag the preamble when it shares the question\'s timestamp', async () => {
    const { restoreAskFlags } = await import('../../lib/transcriptArchiver');
    const reparsed: TranscriptMessage[] = [
      { role: 'assistant', content: 'One decision first.', timestamp: 'T' },
      { role: 'assistant', content: 'Scope?', timestamp: 'T', askQuestion: true },
    ];
    const stored = strip(reparsed) as TranscriptMessage[];
    restoreAskFlags(stored, reparsed);
    expect(stored[0].askQuestion).toBeUndefined();
    expect(stored[1].askQuestion).toBe(true);
  });
});

describe('loadTranscript — AskUserQuestion flags survive the archive', () => {
  afterAll(async () => {
    try { (await (await import('../../lib/db')).getDb()).close(); } catch { /* cleanup only */ }
    try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* cleanup only */ }
  });

  it('restores the flags, keeps the spliced plan bubble, and groups the turn correctly', async () => {
    const { parseTranscriptJsonl } = await import('../../lib/transcriptParser');
    const { archiveTranscript, loadTranscript } = await import('../../lib/transcriptArchiver');
    const { groupTurns } = await import('../../lib/transcriptTurns');

    const content = askConvo.join('\n');
    const { messages, rawLines } = parseTranscriptJsonl(content);
    // Simulate /api/transcript splicing a plan bubble (not reproducible from raw_jsonl).
    const answerIdx = messages.findIndex(m => m.askAnswer);
    messages.splice(answerIdx + 1, 0, { role: 'assistant', content: '# The Plan', timestamp: messages[answerIdx].timestamp });

    await archiveTranscript(SESSION, PROJECT, 'set things up', content, messages, rawLines, true,
      { usageEvents: [], numCompactions: 0, totalOutputTokens: 0, contextTokens: 0 });

    const loaded = await loadTranscript(SESSION);
    expect(loaded).not.toBeNull();
    const view = loaded!.messages.map(m => [m.role, m.askQuestion ? 'Q' : m.askAnswer ? 'A' : '-', m.content]);
    expect(view).toEqual([
      ['user', '-', 'set things up'],
      ['assistant', '-', 'One decision first.'],
      ['assistant', 'Q', 'Scope?\n\n- Yes\n- No'],
      ['user', 'A', 'Yes'],
      ['assistant', '-', '# The Plan'],   // kept — not in raw_jsonl
      ['assistant', '-', 'All set.'],
      ['user', '-', 'Yes'],               // ordinary prompt, unflagged
      ['assistant', '-', 'Noted.'],
    ]);

    // Two turns, not three: the answer doesn't split the first one.
    const turns = groupTurns(loaded!.messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistant?.content).toBe('All set.');
    expect(turns[0].intermediaries.map(m => m.content)).toEqual([
      'One decision first.', 'Scope?\n\n- Yes\n- No', 'Yes', '# The Plan',
    ]);
    expect(turns[1].user?.content).toBe('Yes');
  });
});
