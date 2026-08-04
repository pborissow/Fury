/**
 * F3 (docs/ticket-sdk-pivot-premerge-review.md): sendMessage must not start a second
 * turn while one is in flight. Before the guard, a double-send (double-click / retry)
 * replaced s.streamBuffer and cleared s.usageByMsg mid-turn, silently losing turn 1's
 * stream buffer and token tally. White-box test: seed a session as "turn 1 in flight"
 * and assert a second sendMessage rejects and leaves turn-1 state untouched.
 */
import { describe, it, expect } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

describe('sendMessage re-entrancy guard (F3)', () => {
  it('rejects a second send while a turn is in flight, without clobbering turn 1', async () => {
    const mgr = sdkSessionManager as unknown as {
      getOrCreate(id: string): {
        isProcessing: boolean;
        streamBuffer: unknown;
        usageByMsg: Map<string, unknown>;
        turnEpoch: number;
      };
      sessions: Map<string, unknown>;
    };
    const id = 'f3-guard-fixture';
    const s = mgr.getOrCreate(id);

    // Simulate turn 1 in flight with a real buffer + token tally.
    s.isProcessing = true;
    s.streamBuffer = { userPrompt: 'turn-1 prompt', accumulatedText: 'partial answer', events: [{}], isActive: true, startedAt: 1 };
    s.usageByMsg.set('msg-1', { inputTokens: 10 });
    const epochBefore = s.turnEpoch;

    await expect(sdkSessionManager.sendMessage(id, 'turn-2 prompt'))
      .rejects.toThrow(/already in progress/i);

    // Turn 1's buffer, token tally, and epoch are intact — nothing was reset.
    expect((s.streamBuffer as { userPrompt: string }).userPrompt).toBe('turn-1 prompt');
    expect((s.streamBuffer as { accumulatedText: string }).accumulatedText).toBe('partial answer');
    expect(s.usageByMsg.has('msg-1')).toBe(true);
    expect(s.turnEpoch).toBe(epochBefore);
    expect(s.isProcessing).toBe(true);

    mgr.sessions.delete(id);
  });
});
