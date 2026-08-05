/**
 * Spurious "stuck" flash at turn start after an idle gap.
 *
 * computeStuck measures `Date.now() - s.lastActivity`, but lastActivity was only
 * refreshed on session creation and on each INCOMING SDK message — never at turn
 * start. sendMessage emits health with isProcessing:true immediately, so a
 * follow-up sent after an idle gap longer than STUCK_AFTER_MS reported, at the
 * instant of send, "No response from Claude for Ns — the session may be stuck."
 * It self-corrected on the first token, but the trigger (come back later, send a
 * follow-up) is common and the message is wrong.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

interface Session {
  isProcessing: boolean;
  lastActivity: number;
  projectPath?: string;
}
const mgr = sdkSessionManager as unknown as {
  getOrCreate(id: string): Session;
  computeStuck(s: Session, isProcessing: boolean, backgroundActive: boolean):
    { isStuck: boolean; stuckReason?: string };
  ensureModelHydrated(s: Session): Promise<void>;
  sessions: Map<string, unknown>;
  STUCK_AFTER_MS: number;
};

const createdIds: string[] = [];
function newSession(id: string): Session {
  createdIds.push(id);
  const s = mgr.getOrCreate(id);
  s.projectPath = undefined; // skip the watcher call in sendMessage
  return s;
}

/**
 * Drive sendMessage far enough to pass the re-entrancy claim, then abort before a
 * real query opens. The first await inside the try is ensureModelHydrated; making
 * it throw releases the claim and rethrows, so nothing is left in flight.
 */
async function sendAndStopBeforeQuery(id: string): Promise<void> {
  const orig = mgr.ensureModelHydrated;
  (mgr as unknown as Record<string, unknown>).ensureModelHydrated = async () => {
    throw new Error('stub: stop before startQuery');
  };
  try {
    await expect(sdkSessionManager.sendMessage(id, 'follow-up after a break'))
      .rejects.toThrow('stub: stop before startQuery');
  } finally {
    (mgr as unknown as Record<string, unknown>).ensureModelHydrated = orig;
  }
}

afterEach(() => {
  for (const id of createdIds.splice(0)) mgr.sessions.delete(id);
});

describe('stuck detector at turn start', () => {
  it('an idle gap alone would have tripped it (the bug being fixed)', () => {
    const s = newSession('stuck-flash-control');
    s.lastActivity = Date.now() - (mgr.STUCK_AFTER_MS + 60_000);
    // This is exactly what emitHealth(s, true) saw at the instant of send.
    const { isStuck, stuckReason } = mgr.computeStuck(s, true, false);
    expect(isStuck).toBe(true);
    expect(stuckReason).toMatch(/may be stuck/i);
  });

  it('sending a follow-up after a long idle gap does NOT report stuck', async () => {
    const s = newSession('stuck-flash-send');
    s.lastActivity = Date.now() - (mgr.STUCK_AFTER_MS + 60_000);

    await sendAndStopBeforeQuery('stuck-flash-send');

    // The turn stamped lastActivity, so the detector now measures from turn start.
    expect(Date.now() - s.lastActivity).toBeLessThan(5_000);
    expect(mgr.computeStuck(s, true, false).isStuck).toBe(false);
  });

  it('stamps at the re-entrancy claim, so a slow pre-turn await is still covered', async () => {
    // The claim and the per-turn setup block are separated by awaits, and a
    // reconcile-tick health emit can land in between. Stamping at the claim means
    // isProcessing:true and a fresh lastActivity are never observable apart.
    const s = newSession('stuck-flash-claim');
    s.lastActivity = Date.now() - (mgr.STUCK_AFTER_MS + 60_000);
    let atFirstAwait = -1;

    const orig = mgr.ensureModelHydrated;
    (mgr as unknown as Record<string, unknown>).ensureModelHydrated = async () => {
      atFirstAwait = s.lastActivity; // already inside the claim
      throw new Error('stub');
    };
    try {
      await expect(sdkSessionManager.sendMessage('stuck-flash-claim', 'x')).rejects.toThrow('stub');
    } finally {
      (mgr as unknown as Record<string, unknown>).ensureModelHydrated = orig;
    }

    expect(Date.now() - atFirstAwait).toBeLessThan(5_000);
  });

  it('still reports stuck for a turn that genuinely went silent', async () => {
    // The fix must not defang the detector: stamp at turn start, then let the
    // window elapse with no incoming message.
    const s = newSession('stuck-flash-genuine');
    await sendAndStopBeforeQuery('stuck-flash-genuine');

    s.lastActivity = Date.now() - (mgr.STUCK_AFTER_MS + 1_000);
    expect(mgr.computeStuck(s, true, false).isStuck).toBe(true);
  });

  it('never stuck while idle or while background work is in flight', () => {
    const s = newSession('stuck-flash-gates');
    s.lastActivity = Date.now() - (mgr.STUCK_AFTER_MS + 60_000);
    expect(mgr.computeStuck(s, false, false).isStuck).toBe(false); // not processing
    expect(mgr.computeStuck(s, true, true).isStuck).toBe(false);   // background active
  });
});
