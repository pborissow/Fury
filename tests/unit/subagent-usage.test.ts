/**
 * Subagent (sidechain) usage ingestion (docs/ticket-stats-undercount-subagent-tokens.md).
 *
 * The SDK writes subagent turns to sidecar transcripts the main archiver never read,
 * so Stats undercounted delegated sessions ~10x. parseSubagentUsageEvents parses
 * those sidecars into usage events billed to the PARENT session: forced sidechain,
 * namespaced message ids (PK-collision-safe), tagged agentId.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSubagentUsageEvents } from '../../lib/subagentUsage';

const asstLine = (id: string, model: string, usage: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${id}`,
    timestamp: '2026-07-30T00:00:00Z',
    message: { id, model, content: [{ type: 'text', text: 'x' }], usage },
  }) + '\n';

let dir: string;
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('parseSubagentUsageEvents', () => {
  it('parses sidecars into sidechain usage billed to the parent (namespaced, tagged)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fury-subagents-'));
    writeFileSync(join(dir, 'agent-aaa111.jsonl'),
      asstLine('msg_1', 'claude-sonnet-4-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }));
    writeFileSync(join(dir, 'agent-bbb222.jsonl'),
      asstLine('msg_2', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }));

    const events = await parseSubagentUsageEvents(dir);
    expect(events).toHaveLength(2);

    const a = events.find((e) => e.agentId === 'aaa111')!;
    expect(a.isSidechain).toBe(true);
    expect(a.messageId).toBe('aaa111:msg_1'); // namespaced by agent id → PK-safe
    expect(a.model).toBe('claude-sonnet-4-5'); // subagent model can differ from parent
    expect([a.input, a.output, a.cacheRead, a.cacheWrite]).toEqual([10, 20, 100, 5]);

    // A second subagent whose message id would otherwise collide stays distinct.
    const b = events.find((e) => e.agentId === 'bbb222')!;
    expect(b.messageId).toBe('bbb222:msg_2');
    expect(b.isSidechain).toBe(true);
  });

  it('two subagents with the SAME message id do not collide (namespacing)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fury-subagents-'));
    writeFileSync(join(dir, 'agent-one.jsonl'), asstLine('dup', 'claude-sonnet-4-5', { input_tokens: 1, output_tokens: 1 }));
    writeFileSync(join(dir, 'agent-two.jsonl'), asstLine('dup', 'claude-sonnet-4-5', { input_tokens: 2, output_tokens: 2 }));
    const ids = (await parseSubagentUsageEvents(dir)).map((e) => e.messageId).sort();
    expect(ids).toEqual(['one:dup', 'two:dup']);
  });

  it('returns [] when there is no subagents dir', async () => {
    dir = join(tmpdir(), `fury-nope-${process.pid}`);
    expect(await parseSubagentUsageEvents(dir)).toEqual([]);
  });

  it('ignores non-agent and empty files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fury-subagents-'));
    writeFileSync(join(dir, 'README.txt'), 'not a sidecar');
    writeFileSync(join(dir, 'agent-empty.jsonl'), '');
    mkdirSync(join(dir, 'agent-dir.jsonl')); // a dir, not a file — must be skipped
    expect(await parseSubagentUsageEvents(dir)).toEqual([]);
  });
});
