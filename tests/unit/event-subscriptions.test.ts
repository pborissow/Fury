/**
 * Server-side watch registry for the shared `/api/events` stream
 * (lib/eventSubscriptions.ts).
 *
 * Session-scoped events ride the window's one shared stream, and each stream
 * watches sessions through the POST control channel. These tests pin two
 * things: watches hold exactly one transcript-watcher reference each, and
 * closing a stream (abort, cancel, liveness probe) releases every one of them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fw = vi.hoisted(() => ({
  watchTranscript: vi.fn(),
  unwatchTranscript: vi.fn(),
}));
vi.mock('../../lib/fileWatchers', () => ({ fileWatchers: fw }));

import { EventSubscriptionRegistry, isValidSessionWatch } from '../../lib/eventSubscriptions';

let reg: EventSubscriptionRegistry;
beforeEach(() => {
  fw.watchTranscript.mockClear();
  fw.unwatchTranscript.mockClear();
  reg = new EventSubscriptionRegistry();
});

describe('EventSubscriptionRegistry', () => {
  it('delivers only watched sessions, per subscription', () => {
    const a = reg.create();
    const b = reg.create();
    expect(reg.watch(a, 's1', '/p')).toBe('ok');
    expect(reg.isWatching(a, 's1')).toBe(true);
    expect(reg.isWatching(b, 's1')).toBe(false);
    expect(reg.isWatching(a, 's2')).toBe(false);
  });

  it('takes one transcript-watcher reference per watch, idempotently', () => {
    const a = reg.create();
    reg.watch(a, 's1', '/p');
    reg.watch(a, 's1', '/p');
    expect(fw.watchTranscript).toHaveBeenCalledTimes(1);
    reg.unwatch(a, 's1');
    reg.unwatch(a, 's1');
    expect(fw.unwatchTranscript).toHaveBeenCalledTimes(1);
    expect(reg.isWatching(a, 's1')).toBe(false);
  });

  it('close() releases EVERY watched session and forgets the id', () => {
    const a = reg.create();
    reg.watch(a, 's1', '/p');
    reg.watch(a, 's2', '/q');
    reg.close(a);
    expect(fw.unwatchTranscript.mock.calls.map(c => c[0]).sort()).toEqual(['s1', 's2']);
    expect(reg.has(a)).toBe(false);
    expect(reg.stats()).toEqual({ subscriptions: 0, watchedSessions: 0 });
    reg.close(a); // idempotent
    expect(fw.unwatchTranscript).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown subscription so the client can rely on reconnect', () => {
    expect(reg.watch('nope', 's1', '/p')).toBe('unknown');
    expect(reg.unwatch('nope', 's1')).toBe(false);
    expect(fw.watchTranscript).not.toHaveBeenCalled();
  });

  it("reports 'full' past the per-stream cap instead of pretending success", () => {
    const a = reg.create();
    for (let i = 0; i < 32; i++) expect(reg.watch(a, `s${i}`, '/p')).toBe('ok');
    expect(reg.watch(a, 'one-too-many', '/p')).toBe('full');
    expect(reg.isWatching(a, 'one-too-many')).toBe(false);
    expect(reg.watch(a, 's0', '/p')).toBe('ok'); // an existing watch is still fine
    expect(fw.watchTranscript).toHaveBeenCalledTimes(32);
  });

  it('counts subscriptions and watched sessions for diagnostics', () => {
    const a = reg.create();
    const b = reg.create();
    reg.watch(a, 's1', '/p');
    reg.watch(b, 's1', '/p');
    reg.watch(b, 's2', '/p');
    expect(reg.stats()).toEqual({ subscriptions: 2, watchedSessions: 3 });
  });
});

describe('isValidSessionWatch', () => {
  it('accepts a UUID session id and a project path', () => {
    expect(isValidSessionWatch({ sessionId: '0b0c7a4e-1f2d-4c3b-9a8e-123456789abc', project: 'C:\\x' })).toBe(true);
  });
  it('rejects path-like ids, empty projects and non-objects', () => {
    expect(isValidSessionWatch({ sessionId: '../../etc', project: '/p' })).toBe(false);
    expect(isValidSessionWatch({ sessionId: 's1', project: '' })).toBe(false);
    expect(isValidSessionWatch({ sessionId: 's1' })).toBe(false);
    expect(isValidSessionWatch(null)).toBe(false);
    expect(isValidSessionWatch('s1')).toBe(false);
  });
});
