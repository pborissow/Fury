import { describe, it, expect } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

// handle()/getOrCreate are private; we drive them directly so this stays a fast
// deterministic unit test instead of paying for two live turns on two models.
const mgr = sdkSessionManager as any;

/**
 * The EXACT modelUsage a live session reports after Query.setModel('haiku'),
 * captured by probing the real SDK. The load-bearing detail: it is CUMULATIVE
 * across the session — the Opus entry never leaves once Opus has run — and the
 * keys carry the context-variant suffix while assistant messages report the
 * bare id.
 */
const USAGE_AFTER_SWITCH_TO_HAIKU = {
  'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
  'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
};
const USAGE_OPUS_ONLY = {
  'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
};

const result = (modelUsage: unknown) => ({ type: 'result', modelUsage });

/** An assistant turn on the main thread — this is what sets the session's model. */
const mainAssistant = (model: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: `m-${model}-${Math.random()}`, model, content: [] },
});

/** A subagent's assistant turn, carrying the SUBAGENT's model. */
const subAssistant = (model: string) => ({
  type: 'assistant',
  parent_tool_use_id: 'toolu_sub_1',
  message: { id: `sub-${Math.random()}`, model, content: [] },
});

describe('sdkSessionManager: context window across a model switch', () => {
  it('uses the main model own window, not the roomiest the session ever ran', () => {
    const s = mgr.getOrCreate('ctxwin-switch-1');

    // Turn 1 on the default model.
    mgr.handle(s, mainAssistant('claude-opus-4-8'));
    mgr.handle(s, result(USAGE_OPUS_ONLY));
    expect(s.contextWindow, 'Opus session reports its 1M window').toBe(1_000_000);

    // The user switches to Haiku; the next turn is served by Haiku, but Opus's
    // entry is still in modelUsage forever.
    mgr.handle(s, mainAssistant('claude-haiku-4-5-20251001'));
    mgr.handle(s, result(USAGE_AFTER_SWITCH_TO_HAIKU));

    // Taking the max here yields 1_000_000 — the session would report a 5x-too-
    // roomy window for the rest of its life, so a 190k conversation renders as
    // "19% full" instead of 95% and never trips the >=70% warning.
    expect(s.contextWindow, 'a Haiku-pinned session is bounded by Haiku 200k').toBe(200_000);
  });

  it('matches the variant-suffixed modelUsage key against the bare reported id', () => {
    const s = mgr.getOrCreate('ctxwin-switch-2');
    // Assistant messages report 'claude-opus-4-8'; modelUsage keys it as
    // 'claude-opus-4-8[1m]'. A strict compare finds nothing and silently falls
    // back to the max. The decoy is deliberately ROOMIER than the real entry so
    // that falling back is distinguishable from matching — otherwise this test
    // passes for the wrong reason.
    mgr.handle(s, mainAssistant('claude-opus-4-8'));
    mgr.handle(s, result({
      'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
      'some-other-model': { contextWindow: 5_000_000 },
    }));
    expect(s.contextWindow, 'must match through the [1m] suffix, not fall back to max').toBe(1_000_000);
  });

  it('a subagent model does not become the session model', () => {
    const s = mgr.getOrCreate('ctxwin-switch-3');
    mgr.handle(s, mainAssistant('claude-opus-4-8'));
    expect(s.lastEmittedModel).toBe('claude-opus-4-8');

    // A Task subagent running Haiku must not repoint the session — it would
    // flip the status bar mid-turn AND size the fill bar to 200k.
    mgr.handle(s, subAssistant('claude-haiku-4-5-20251001'));
    expect(s.lastEmittedModel, 'subagent must not define the session model').toBe('claude-opus-4-8');

    mgr.handle(s, result(USAGE_AFTER_SWITCH_TO_HAIKU));
    expect(s.contextWindow, 'main thread is still Opus, so still 1M').toBe(1_000_000);
  });

  it('falls back to the roomiest window when the main model is unknown', () => {
    const s = mgr.getOrCreate('ctxwin-switch-4');
    // No assistant turn yet => no main model. Falling back to the max preserves
    // the original rule: never pick a small subagent window and render >100%.
    mgr.handle(s, result(USAGE_AFTER_SWITCH_TO_HAIKU));
    expect(s.contextWindow).toBe(1_000_000);
  });
});
