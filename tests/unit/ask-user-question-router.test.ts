import { describe, it, expect, vi } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

/**
 * The canUseTool router: the seam where Claude PARKS on a question instead of
 * being killed mid-turn and re-prompted with prose.
 *
 * Every test here guards a way the held promise could fail to settle. That is
 * the whole risk surface: permission prompts have no park deadline
 * (sdk.d.ts:204), so a promise we never resolve blocks the tool — and the warm
 * process — forever.
 */

const mgr = () => sdkSessionManager as any;

/** A session record shaped like the parts the router actually touches. */
function fakeSession(sessionId = 'sess-1') {
  return { sessionId, pendingAsk: undefined as any };
}

function opts(overrides: Partial<{ signal: AbortSignal; toolUseID: string; agentID: string }> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    ...overrides,
  } as { signal: AbortSignal; toolUseID: string; agentID?: string };
}

const QUESTION_INPUT = {
  questions: [{ question: 'Tabs or spaces?', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] }],
};

describe('canUseTool router', () => {
  it('allows every other tool straight through, input untouched', async () => {
    const s = fakeSession();
    const route = mgr().canUseTool(s);
    const input = { command: 'ls -la' };

    // Must not await a dialog: gating Bash/Edit behind a prompt is out of scope,
    // and parking here would hang every ordinary tool call.
    const result = await route('Bash', input, opts());

    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(s.pendingAsk).toBeUndefined();
  });

  it('parks on AskUserQuestion without resolving, and registers pendingAsk', async () => {
    const s = fakeSession();
    const route = mgr().canUseTool(s);

    let settled = false;
    const promise = route('AskUserQuestion', QUESTION_INPUT, opts()).then((r: unknown) => {
      settled = true;
      return r;
    });

    await Promise.resolve();
    // THE POINT: the turn is still blocked here. If this resolves on its own,
    // Claude never waits and the whole design is moot.
    expect(settled).toBe(false);
    expect(s.pendingAsk?.toolUseID).toBe('toolu_1');
    expect(s.pendingAsk?.questions).toEqual(QUESTION_INPUT.questions);

    // Don't leak the pending promise out of the test.
    s.pendingAsk.resolve({ behavior: 'deny', message: 'cleanup' });
    await promise;
  });

  it('resolves with answers threaded into updatedInput, preserving the original input', async () => {
    const s = fakeSession();
    const route = mgr().canUseTool(s);
    const promise = route('AskUserQuestion', QUESTION_INPUT, opts());

    await Promise.resolve();
    s.pendingAsk.resolve({
      behavior: 'allow',
      updatedInput: { ...QUESTION_INPUT, answers: { 'Tabs or spaces?': 'Spaces' } },
    });

    expect(await promise).toEqual({
      behavior: 'allow',
      updatedInput: { ...QUESTION_INPUT, answers: { 'Tabs or spaces?': 'Spaces' } },
    });
  });

  it('denies on abort — TRAP #2: an unheard abort leaks the callback forever', async () => {
    const s = fakeSession();
    const ac = new AbortController();
    const route = mgr().canUseTool(s);
    const promise = route('AskUserQuestion', QUESTION_INPUT, opts({ signal: ac.signal }));

    await Promise.resolve();
    expect(s.pendingAsk).toBeDefined();

    // stop() / killSession() do exactly this.
    ac.abort();

    const result = await promise;
    expect(result.behavior).toBe('deny');
    expect(s.pendingAsk).toBeUndefined();
  });

  it('denies immediately when the signal is ALREADY aborted', async () => {
    // A race: teardown between the model emitting the tool and us being called.
    // addEventListener alone never fires for an already-aborted signal, so
    // without the upfront check this promise would hang forever.
    const s = fakeSession();
    const ac = new AbortController();
    ac.abort();
    const route = mgr().canUseTool(s);

    const result = await route('AskUserQuestion', QUESTION_INPUT, opts({ signal: ac.signal }));
    expect(result.behavior).toBe('deny');
    expect(s.pendingAsk).toBeUndefined();
  });

  it('denies a subagent ask instead of parking on a dialog nobody can see', async () => {
    const s = fakeSession();
    const route = mgr().canUseTool(s);

    const result = await route('AskUserQuestion', QUESTION_INPUT, opts({ agentID: 'agent-7' }));

    expect(result.behavior).toBe('deny');
    // Must not occupy the single slot — a sidechain would otherwise overwrite
    // the main turn's question and resolve the WRONG promise.
    expect(s.pendingAsk).toBeUndefined();
  });

  it('resolves the stale promise (and warns) if the slot is ever overwritten', async () => {
    const s = fakeSession();
    const route = mgr().canUseTool(s);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = route('AskUserQuestion', QUESTION_INPUT, opts({ toolUseID: 'toolu_A' }));
      await Promise.resolve();

      const second = route('AskUserQuestion', QUESTION_INPUT, opts({ toolUseID: 'toolu_B' }));
      await Promise.resolve();

      // The first must not be orphaned — that's a permanently blocked tool call.
      expect((await first).behavior).toBe('deny');
      expect(warn).toHaveBeenCalled();
      expect(s.pendingAsk?.toolUseID).toBe('toolu_B');

      s.pendingAsk.resolve({ behavior: 'deny', message: 'cleanup' });
      await second;
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveAsk (POST /api/claude-sdk/answer)', () => {
  const withSession = async (fn: (sessionId: string, s: any, promise: Promise<any>) => Promise<void>) => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const s = mgr().getOrCreate(sessionId);
    const route = mgr().canUseTool(s);
    const promise = route('AskUserQuestion', QUESTION_INPUT, opts({ toolUseID: 'toolu_live' }));
    await Promise.resolve();
    try {
      await fn(sessionId, s, promise);
    } finally {
      s.pendingAsk?.resolve({ behavior: 'deny', message: 'cleanup' });
      mgr().sessions.delete(sessionId);
    }
  };

  it('resolves the parked question with answers, in place', async () => {
    await withSession(async (sessionId, _s, promise) => {
      const ok = sdkSessionManager.resolveAsk(sessionId, 'toolu_live', {
        answers: { 'Tabs or spaces?': 'Spaces' },
      });
      expect(ok).toBe(true);

      const result = await promise;
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput.answers).toEqual({ 'Tabs or spaces?': 'Spaces' });
      // The tool's original input must survive alongside the answers.
      expect(result.updatedInput.questions).toEqual(QUESTION_INPUT.questions);
    });
  });

  it('IGNORES a mismatched toolUseID — a stale dialog must not answer the live question', async () => {
    await withSession(async (sessionId, s) => {
      const ok = sdkSessionManager.resolveAsk(sessionId, 'toolu_STALE', {
        answers: { 'Tabs or spaces?': 'Tabs' },
      });
      expect(ok).toBe(false);
      // Still parked, still answerable by the right dialog.
      expect(s.pendingAsk?.toolUseID).toBe('toolu_live');
    });
  });

  it('denies on skip so the model learns the user declined', async () => {
    await withSession(async (sessionId, _s, promise) => {
      expect(sdkSessionManager.resolveAsk(sessionId, 'toolu_live', { skip: true })).toBe(true);
      const result = await promise;
      expect(result.behavior).toBe('deny');
      expect(result.message).toMatch(/dismissed/i);
    });
  });

  it('plumbs annotations through when present', async () => {
    await withSession(async (sessionId, _s, promise) => {
      sdkSessionManager.resolveAsk(sessionId, 'toolu_live', {
        answers: { 'Tabs or spaces?': 'Spaces' },
        annotations: { 'Tabs or spaces?': { notes: 'but 2-wide' } },
      });
      const result = await promise;
      expect(result.updatedInput.annotations).toEqual({ 'Tabs or spaces?': { notes: 'but 2-wide' } });
    });
  });

  it('returns false for an unknown session rather than throwing', async () => {
    expect(
      sdkSessionManager.resolveAsk('99999999-9999-4999-8999-999999999999', 'toolu_x', { skip: true }),
    ).toBe(false);
  });

  it('is not answerable twice — the second answer finds nothing parked', async () => {
    await withSession(async (sessionId, _s, promise) => {
      expect(sdkSessionManager.resolveAsk(sessionId, 'toolu_live', { answers: { a: 'b' } })).toBe(true);
      await promise;
      // A double-submit (or a second tab) must not resolve an already-settled
      // promise — resolve() twice is a silent no-op, so this is the only signal.
      expect(sdkSessionManager.resolveAsk(sessionId, 'toolu_live', { answers: { a: 'c' } })).toBe(false);
    });
  });
});

describe('sendMessage while parked', () => {
  it('rejects rather than queueing a prompt behind the blocked tool call', async () => {
    const sessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const s = mgr().getOrCreate(sessionId);
    try {
      s.pendingAsk = { toolUseID: 't', questions: [], input: {}, resolve: () => {} };
      // Pushing into the input stream would NOT answer the question; it would
      // surface later, out of context, while the dialog still waits.
      await expect(sdkSessionManager.sendMessage(sessionId, 'hello')).rejects.toThrow(/waiting for an answer/i);
    } finally {
      mgr().sessions.delete(sessionId);
    }
  });
});

/**
 * interrupt() is the ESCAPE HATCH — both recovery buttons land here
 * (handleTranscriptStop and handleKillStuckSession). It is also the one
 * lifecycle path that neither aborts the abortController nor ends the input
 * stream, so the router's signal listener and consume()'s finally BOTH miss it.
 *
 * The original implementation covered exactly the paths the design doc named
 * (stop/killSession) and left this one stranding the turn. These tests exist so
 * that never regresses: the button whose entire job is "get me out of this" must
 * not be the one that wedges the process.
 */
describe('interrupt() while parked', () => {
  const parkOn = (sessionId: string) => {
    const s: any = mgr().getOrCreate(sessionId);
    s.isProcessing = true;
    s.q = { interrupt: async () => {} };
    s.abortController = new AbortController();
    const promise = mgr().canUseTool(s)('AskUserQuestion', QUESTION_INPUT, {
      signal: s.abortController.signal,
      toolUseID: 'toolu_int',
    });
    return { s, promise };
  };

  it('settles the parked question instead of leaving the CLI blocked', async () => {
    const sessionId = 'cccccccc-dddd-4eee-8fff-000000000000';
    const { s, promise } = parkOn(sessionId);
    try {
      await Promise.resolve();
      expect(s.pendingAsk?.toolUseID).toBe('toolu_int');

      await sdkSessionManager.interrupt(sessionId);

      // Without this the UI reports idle (isProcessing false) while the process
      // is still blocked in canUseTool — and a later answer would RESUME the
      // very turn the user just stopped.
      expect(s.isProcessing).toBe(false);
      expect(s.pendingAsk, 'interrupt must not strand the parked question').toBeUndefined();
      expect((await promise).behavior).toBe('deny');
    } finally {
      mgr().sessions.delete(sessionId);
    }
  });

  it('unblocks the composer for real — a follow-up send is accepted, not silently swallowed', async () => {
    // The chain this breaks: Stop while parked -> dialog gone but slot still set
    // -> every later send throws inside a fire-and-forget dispatch -> {ok:true}
    // to the client -> spinner forever, message vanished.
    const sessionId = 'dddddddd-eeee-4fff-8000-111111111111';
    const { s, promise } = parkOn(sessionId);
    try {
      await Promise.resolve();
      await sdkSessionManager.interrupt(sessionId);
      await promise;

      // The guard must no longer trip: there is nothing parked to wait on.
      expect(sdkSessionManager.getPendingAsk(sessionId)).toBeNull();
    } finally {
      mgr().sessions.delete(sessionId);
    }
  });

  it('is safe to call when nothing is parked', async () => {
    const sessionId = 'eeeeeeee-ffff-4000-8111-222222222222';
    const s: any = mgr().getOrCreate(sessionId);
    s.q = { interrupt: async () => {} };
    try {
      await expect(sdkSessionManager.interrupt(sessionId)).resolves.toBeUndefined();
    } finally {
      mgr().sessions.delete(sessionId);
    }
  });
});
