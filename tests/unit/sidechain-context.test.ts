import { describe, it, expect } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

// handle()/getOrCreate are private; we drive them directly so this stays a fast
// deterministic unit test instead of paying for a live Task-spawning turn.
const mgr = sdkSessionManager as any;

const usage = (prompt: number, output = 0) => ({
  input_tokens: prompt,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

/** Main-thread streaming start (parent_tool_use_id null). */
const mainStart = (id: string, prompt: number) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_start', message: { id, usage: usage(prompt) } },
});

/** Subagent assistant message — forwarded by default with real usage. */
const subAssistant = (id: string, prompt: number) => ({
  type: 'assistant',
  parent_tool_use_id: 'toolu_sub_1',
  message: { id, model: 'claude-opus-4-8', content: [], usage: usage(prompt, 5) },
});

const mainAssistant = (id: string, prompt: number) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id, model: 'claude-opus-4-8', content: [], usage: usage(prompt, 5) },
});

describe('sdkSessionManager: sidechain guard on contextTokens', () => {
  it('a subagent message does not clobber the main thread context reading', () => {
    const s = mgr.getOrCreate('sidechain-test-1');
    mgr.handle(s, mainStart('m1', 23_500));
    expect(s.contextTokens).toBe(23_500);

    // Real values observed from a live Task turn: the subagent's fresh context
    // was 2950 vs the main thread's ~23.5k. Before the guard this assigned.
    mgr.handle(s, subAssistant('sub1', 2_950));
    expect(s.contextTokens, 'subagent must not define main-thread occupancy').toBe(23_500);

    // The main thread moving still updates it.
    mgr.handle(s, mainAssistant('m2', 23_800));
    expect(s.contextTokens).toBe(23_800);
  });

  it('subagent tokens are still billed — they stay in the turn tally', () => {
    const s = mgr.getOrCreate('sidechain-test-2');
    mgr.handle(s, mainStart('m1', 1_000));
    mgr.handle(s, subAssistant('sub1', 500));
    const total = [...s.usageByMsg.values()].reduce((a: number, b: number) => a + b, 0);
    // 1000 (main) + 500 prompt + 5 output (sub) = 1505
    expect(total, 'sidechain tokens are real spend and must be counted').toBe(1_505);
  });

  it('sidechain-only traffic leaves contextTokens untouched (never zeroed)', () => {
    const s = mgr.getOrCreate('sidechain-test-3');
    mgr.handle(s, mainStart('m1', 12_000));
    mgr.handle(s, subAssistant('sub1', 900));
    mgr.handle(s, subAssistant('sub2', 1_100));
    expect(s.contextTokens).toBe(12_000);
  });
});
