/**
 * setModel must make the picked model authoritative for the NEXT turn, even when
 * the session has never run (not in the manager's map yet) — the mid-session picker
 * on a reopened archived session, or a brand-new session with no DB row.
 *
 * Regression guard: an earlier attempt to avoid growing the sessions map (P21) made
 * setModel persist to the DB only, with no in-memory record, for a not-in-map
 * session. That silently reverted the session to the default model — a fire-and-
 * forget write could lose the race against the send or be dropped after the route
 * responded, and for a session with no DB row the persist was a no-op. The fix
 * records the choice on the in-memory session synchronously so startQuery replays
 * it; this test pins that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

const mgr = sdkSessionManager as any;
const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;

const ids: string[] = [];
afterEach(() => { for (const id of ids.splice(0)) sessions.delete(id); });

describe('setModel on a not-yet-run session', () => {
  it('records the pick in memory (authoritative for the first send), not DB-only', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    ids.push(id);
    expect(sessions.has(id)).toBe(false); // never run → not in the map

    const res = await sdkSessionManager.setModel(id, 'claude-opus-4-8');

    // No live query yet, so it applies as pending — but the choice must be held in
    // memory so the imminent first send/startQuery uses it (not the default).
    expect(res).toEqual({ applied: 'pending' });
    const s = sessions.get(id) as { model?: string; modelHydrated?: boolean };
    expect(s?.model).toBe('claude-opus-4-8');
    // Marked hydrated so a late ensureModelHydrated read can't overwrite the pick.
    expect(s?.modelHydrated).toBe(true);
  });

  it('clearing to default (undefined) is held in memory too', async () => {
    const id = '99999999-8888-7777-6666-555555555555';
    ids.push(id);
    await sdkSessionManager.setModel(id, undefined);
    const s = sessions.get(id) as { model?: string; modelHydrated?: boolean };
    expect(s?.model).toBeUndefined();
    expect(s?.modelHydrated).toBe(true);
  });
});
