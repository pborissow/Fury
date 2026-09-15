/**
 * Regression (2026-09-05): a <task-notification> injected between two completed
 * assistant turns must NOT cause the earlier turn's final message to be dropped.
 *
 * In the current runtime each task-notification drives its OWN turn, so a long
 * end-of-turn summary can be immediately followed by a notification and a short
 * reply to it. The parser accumulates a single `pendingAssistant` and only
 * flushes it on a real user turn / EOF; a task-notification that merely
 * `continue`d (the old behavior) let the notification-turn's assistant text
 * overwrite the summary, dropping it from the transcript entirely — gone from
 * the main flow AND unreachable via the intermediary dialog. The observed case:
 * a long "All testing is done…" summary swapped for "That's just the file
 * monitor timing out…".
 */
import { describe, it, expect } from 'vitest';
import { parseTranscriptJsonl } from '../../lib/transcriptParser';

const line = (o: unknown) => JSON.stringify(o);
const assistantText = (uuid: string, ts: string, text: string) =>
  line({ type: 'assistant', uuid, timestamp: ts, message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text }] } });
const userText = (uuid: string, ts: string, content: string) =>
  line({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content } });

describe('parseTranscriptJsonl — task-notification turn boundary', () => {
  it('preserves the prior turn-final message when a task-notification drives the next turn', () => {
    const jsonl = [
      userText('u1', '2026-09-05T21:50:00Z', 'review the branch'),
      assistantText('a1', '2026-09-05T21:55:56Z', 'All testing is done. Here is the full picture. ## Summary …'),
      // Background monitor fires — synthetic user message, hidden, but a turn boundary.
      userText('n1', '2026-09-05T21:59:02Z', '<task-notification>\n<task-id>b2z</task-id>\nMonitor event: HEIC param test\n</task-notification>'),
      assistantText('a2', '2026-09-05T21:59:06Z', "That's just the file monitor timing out — it already delivered its results."),
      userText('u2', '2026-09-05T21:59:35Z', 'is it worth updating the pom.xml?'),
    ].join('\n');

    const { messages } = parseTranscriptJsonl(jsonl);
    const assistants = messages.filter(m => m.role === 'assistant').map(m => m.content);

    // BOTH assistant turns survive — the summary is not overwritten by the reply.
    expect(assistants.some(c => c.startsWith('All testing is done'))).toBe(true);
    expect(assistants.some(c => c.startsWith("That's just the file monitor"))).toBe(true);
    expect(assistants).toHaveLength(2);

    // Order preserved, and the task-notification itself never renders as a bubble.
    const si = messages.findIndex(m => m.content.startsWith('All testing is done'));
    const ti = messages.findIndex(m => m.content.startsWith("That's just the file monitor"));
    expect(si).toBeLessThan(ti);
    expect(messages.some(m => m.content.includes('<task-notification>'))).toBe(false);
  });

  it('does not split a single turn whose assistant steps are separated by tool_result', () => {
    // The within-turn case must be unchanged: two assistant texts separated by a
    // tool_result already flush independently (each is its own bubble), and no
    // message is lost regardless.
    const jsonl = [
      userText('u1', '2026-09-05T10:00:00Z', 'do the thing'),
      assistantText('a1', '2026-09-05T10:00:01Z', 'Let me read the file.'),
      line({ type: 'user', uuid: 'tr1', timestamp: '2026-09-05T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      assistantText('a2', '2026-09-05T10:00:03Z', 'Done.'),
    ].join('\n');
    const { messages } = parseTranscriptJsonl(jsonl);
    const assistants = messages.filter(m => m.role === 'assistant').map(m => m.content);
    expect(assistants).toEqual(['Let me read the file.', 'Done.']);
  });
});
