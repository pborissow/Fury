import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscriptJsonl } from '../../lib/transcriptParser';

// Regression coverage for docs/ticket-task-notification-response-dropped.md.
//
// A <task-notification> is the synthetic user message the harness injects when
// a background Task/Agent finishes. The parser must treat it as a *mid-turn
// internal event*, not a turn boundary: the assistant's real reply to it — in
// particular a terminal text answer with no trailing tool call — has to render.
// Only synthetic provenance (model === '<synthetic>', e.g. the "No response
// requested." stub) may be suppressed.

/** Build one JSONL entry line for the transcript. */
function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

/** A user prompt (real, visible) or an internal string (hidden). */
function user(content: unknown, ts = '2026-07-17T00:00:00Z') {
  return line({ type: 'user', message: { role: 'user', content }, timestamp: ts, uuid: `u-${ts}` });
}

/** A tool_result — an array-content user message. Flushes the pending turn,
 *  never renders itself. Stands in for a tool/agent completing. */
function toolResult(ts = '2026-07-17T00:00:02Z') {
  return line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    timestamp: ts,
    uuid: `tr-${ts}`,
  });
}

/** An assistant text message. Pass model '<synthetic>' for a CLI-injected stub. */
function assistant(text: string, model = 'claude-sonnet-5', ts = '2026-07-17T00:00:01Z') {
  return line({
    type: 'assistant',
    message: { role: 'assistant', model, content: [{ type: 'text', text }], usage: { output_tokens: 3 } },
    timestamp: ts,
    uuid: `a-${ts}`,
  });
}

const TASK_NOTIFICATION =
  '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>';

const contents = (jsonl: string) =>
  parseTranscriptJsonl(jsonl).messages.map((m) => ({ role: m.role, content: m.content }));

describe('task-notification response rendering', () => {
  it('renders a terminal assistant answer that replies to a task-notification', () => {
    const jsonl = [
      user('kick off the research and let me know'),
      user(TASK_NOTIFICATION),
      assistant('Got the findings back — here is the full synthesis.'),
      user('great, now do the next thing'),
    ].join('\n');

    const msgs = contents(jsonl);
    expect(msgs).toEqual([
      { role: 'user', content: 'kick off the research and let me know' },
      { role: 'assistant', content: 'Got the findings back — here is the full synthesis.' },
      { role: 'user', content: 'great, now do the next thing' },
    ]);
  });

  it('hides the synthetic "No response requested." stub after a task-notification', () => {
    const jsonl = [
      user('start the background job'),
      user(TASK_NOTIFICATION),
      assistant('No response requested.', '<synthetic>'),
      user('anything else?'),
    ].join('\n');

    const msgs = contents(jsonl);
    // The stub never renders; only the two real user prompts survive.
    expect(msgs).toEqual([
      { role: 'user', content: 'start the background job' },
      { role: 'user', content: 'anything else?' },
    ]);
    expect(msgs.some((m) => m.content.includes('No response requested'))).toBe(false);
  });

  it('hides any synthetic assistant message by provenance, not by content', () => {
    const jsonl = [
      user('go'),
      user(TASK_NOTIFICATION),
      // A non-stub synthetic message (e.g. a usage-limit notice) is still hidden.
      assistant('Approaching usage limit…', '<synthetic>'),
      user('ok'),
    ].join('\n');

    expect(contents(jsonl)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'user', content: 'ok' },
    ]);
  });

  it('renders interim non-synthetic text emitted after a task-notification', () => {
    const jsonl = [
      user('do the thing'),
      user(TASK_NOTIFICATION),
      assistant('Let me check whether the reindex finished.'),
      toolResult(), // the assistant does real work — flushes the interim preamble
      assistant('The reindex is done — here is the result.'),
      user('thanks'),
    ].join('\n');

    expect(contents(jsonl)).toEqual([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'Let me check whether the reindex finished.' },
      { role: 'assistant', content: 'The reindex is done — here is the result.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('a task-notification is not a turn boundary — it does not flush prematurely', () => {
    // Assistant text arrives BEFORE the notification (still pending), then the
    // notification fires, then the terminal answer. Both real texts render; the
    // notification itself does not appear as a message.
    const jsonl = [
      user('research X'),
      assistant('Kicking off a background agent to research X.'),
      toolResult(), // background agent launched — flushes the preamble
      user(TASK_NOTIFICATION),
      assistant('Agent finished — X works like this.'),
      user('perfect'),
    ].join('\n');

    const msgs = contents(jsonl);
    expect(msgs.some((m) => m.content.includes('task-notification'))).toBe(false);
    expect(msgs).toEqual([
      { role: 'user', content: 'research X' },
      { role: 'assistant', content: 'Kicking off a background agent to research X.' },
      { role: 'assistant', content: 'Agent finished — X works like this.' },
      { role: 'user', content: 'perfect' },
    ]);
  });

  it('golden fixture (f51df77b idx ~87): the real dropped terminal answer renders', () => {
    const fixture = readFileSync(
      join(__dirname, 'fixtures', 'task-notification-terminal-f51df77b.jsonl'),
      'utf8',
    );
    const { messages } = parseTranscriptJsonl(fixture);

    // The task-notification line must not surface as a user message.
    expect(messages.some((m) => m.content.includes('<task-notification>'))).toBe(false);

    // The terminal answer that replied to the notification must render.
    const answer = messages.find(
      (m) => m.role === 'assistant' && m.content.startsWith('Got the findings back'),
    );
    expect(answer, 'the "Got the findings back…" answer must render').toBeTruthy();

    // ...and it must come before the next real user prompt ("in parallel…").
    const answerIdx = messages.indexOf(answer!);
    const nextPrompt = messages.findIndex(
      (m, i) => i > answerIdx && m.role === 'user' && m.content.startsWith('in parallel'),
    );
    expect(nextPrompt).toBeGreaterThan(answerIdx);
  });
});
