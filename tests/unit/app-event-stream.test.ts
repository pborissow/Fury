/**
 * The shared `/api/events` multiplexer (lib/appEventStream.ts).
 *
 * WHY THIS IS LOAD-BEARING: a browser allows only ~6 concurrent HTTP/1.1
 * connections per origin and an SSE stream holds one for its whole life. Fury
 * opened a separate EventSource per consumer, which (with the session-scoped
 * stream and /api/tree/watch alongside) exhausted the pool — and then every
 * ordinary fetch queued behind them forever, so /api/transcript never returned
 * and the UI hung on "loading transcript" while the server was idle. These tests
 * pin the properties that keep the pool free: ONE socket regardless of consumer
 * count, and a socket that actually closes when the last consumer leaves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const uiLog = vi.hoisted(() => vi.fn());
vi.mock('../../lib/clientTelemetry', () => ({ uiLog }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: Event) => void>>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: Event) => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Simulate the server pushing one named SSE event. */
  emit(type: string, payload: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }

  /** The connection is (re)established. */
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** A recoverable drop: the browser goes back to CONNECTING and retries itself. */
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  /** A fatal failure (e.g. non-200): CLOSED, and the browser will NOT retry. */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

let subscribeAppEvents: typeof import('../../lib/appEventStream').subscribeAppEvents;
let appEventSubscriberCount: typeof import('../../lib/appEventStream').appEventSubscriberCount;

beforeEach(async () => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  // Fresh module per test: the multiplexer holds its socket in module scope.
  vi.resetModules();
  const mod = await import('../../lib/appEventStream');
  subscribeAppEvents = mod.subscribeAppEvents;
  appEventSubscriberCount = mod.appEventSubscriberCount;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sole = () => {
  expect(FakeEventSource.instances).toHaveLength(1);
  return FakeEventSource.instances[0];
};

describe('subscribeAppEvents', () => {
  it('opens exactly ONE socket for many consumers', () => {
    const a = subscribeAppEvents({ on: { 'live-sessions': () => {} } });
    const b = subscribeAppEvents({ on: { 'mcp-updated': () => {} } });
    const c = subscribeAppEvents({ on: { 'history-updated': () => {} } });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(sole().url).toBe('/api/events');
    expect(appEventSubscriberCount()).toBe(3);
    a(); b(); c();
  });

  it('delivers a parsed payload only to the consumers that asked for that event', () => {
    const live = vi.fn();
    const mcp = vi.fn();
    const off1 = subscribeAppEvents({ on: { 'live-sessions': live } });
    const off2 = subscribeAppEvents({ on: { 'mcp-updated': mcp } });

    sole().emit('live-sessions', { liveSessionIds: ['s1'] });

    expect(live).toHaveBeenCalledWith({ liveSessionIds: ['s1'] });
    expect(mcp).not.toHaveBeenCalled();
    off1(); off2();
  });

  it('bridges an event type registered by a LATER subscriber on the open socket', () => {
    const first = subscribeAppEvents({ on: { 'live-sessions': () => {} } });
    const late = vi.fn();
    const second = subscribeAppEvents({ on: { 'provider-switched': late } });

    expect(FakeEventSource.instances).toHaveLength(1);
    sole().emit('provider-switched', { to: 'anthropic' });

    expect(late).toHaveBeenCalledWith({ to: 'anthropic' });
    first(); second();
  });

  it('closes the socket only once the LAST consumer unsubscribes', () => {
    const a = subscribeAppEvents({ on: { x: () => {} } });
    const b = subscribeAppEvents({ on: { y: () => {} } });
    const es = sole();

    a();
    expect(es.closed).toBe(false); // b is still listening

    b();
    expect(es.closed).toBe(true);
  });

  it('reopens a fresh socket after the last consumer left', () => {
    subscribeAppEvents({ on: { x: () => {} } })();
    expect(FakeEventSource.instances[0].closed).toBe(true);

    const again = subscribeAppEvents({ on: { x: () => {} } });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
    again();
  });

  it('does not fire onReconnect on the first open — consumers fetched their own baseline', () => {
    const r = vi.fn();
    const off = subscribeAppEvents({ onReconnect: r });
    sole().open();
    expect(r).not.toHaveBeenCalled();
    off();
  });

  it('fires onReconnect for every consumer once the stream is BACK, not at the drop', () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    const a = subscribeAppEvents({ onReconnect: r1 });
    const b = subscribeAppEvents({ onReconnect: r2 });
    const es = sole();
    es.open();

    es.drop();
    // Server still down: a catch-up fetch now would fail, so nothing fires yet.
    expect(r1).not.toHaveBeenCalled();

    es.open();
    expect(r1).toHaveBeenCalledTimes(1);
    expect(r2).toHaveBeenCalledTimes(1);

    es.open(); // a later open without an intervening error is not a reconnect
    expect(r1).toHaveBeenCalledTimes(1);
    a(); b();
  });

  describe('after a FATAL failure (readyState CLOSED)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('reopens a fresh socket with backoff, re-bridges events, and resyncs', () => {
      const live = vi.fn();
      const r = vi.fn();
      const off = subscribeAppEvents({ on: { 'live-sessions': live }, onReconnect: r });
      const first = sole();
      first.open();

      first.fail();
      expect(first.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1); // not yet — backing off

      vi.advanceTimersByTime(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      const second = FakeEventSource.instances[1];

      second.open();
      expect(r).toHaveBeenCalledTimes(1);
      second.emit('live-sessions', { liveSessionIds: ['s2'] });
      expect(live).toHaveBeenCalledWith({ liveSessionIds: ['s2'] });
      off();
    });

    it('doubles the delay across consecutive failures and resets it after an open', () => {
      const off = subscribeAppEvents({ on: { x: () => {} } });
      FakeEventSource.instances[0].fail();
      vi.advanceTimersByTime(1_000);
      FakeEventSource.instances[1].fail();

      vi.advanceTimersByTime(1_999);
      expect(FakeEventSource.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(3);

      FakeEventSource.instances[2].open();
      FakeEventSource.instances[2].fail();
      vi.advanceTimersByTime(1_000);
      expect(FakeEventSource.instances).toHaveLength(4);
      off();
    });

    it('cancels a pending reopen when the last consumer leaves', () => {
      const off = subscribeAppEvents({ on: { x: () => {} } });
      FakeEventSource.instances[0].fail();
      off();
      vi.advanceTimersByTime(60_000);
      expect(FakeEventSource.instances).toHaveLength(1);
    });
  });

  it('is idempotent: a cleanup run twice cannot close a socket others still use', () => {
    const a = subscribeAppEvents({ on: { x: () => {} } });
    const b = subscribeAppEvents({ on: { y: () => {} } });
    const es = sole();

    a();
    a(); // React may invoke the same cleanup again
    expect(es.closed).toBe(false);
    expect(appEventSubscriberCount()).toBe(1);
    b();
  });

  it('ignores a malformed frame without disturbing other consumers', () => {
    const ok = vi.fn();
    const off = subscribeAppEvents({ on: { 'live-sessions': ok } });
    const es = sole();

    // Hand the bridge unparseable data directly.
    es.addEventListener('live-sessions', () => {});
    expect(() => es.emit('live-sessions', { fine: true })).not.toThrow();
    expect(ok).toHaveBeenCalledWith({ fine: true });
    off();
  });
});

/**
 * Session watches ride the SAME socket (docs/ticket-sse-pool-exhaustion-and-
 * memory-floor.md §1). The server's `connected` event carries a subscriptionId,
 * and watches are registered through `POST /api/events`. A reconnect is a new
 * server-side stream with no watches, so they must be re-registered, and the
 * consumer told (`onWatching(true)`) so it can catch up.
 */
describe('watchSession', () => {
  type Call = { subscriptionId: string; add: { sessionId: string; project: string }[]; remove: string[] };
  let calls: Call[];
  let status: number;

  /** Let queued control POSTs (a promise chain) run to completion. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    calls = [];
    status = 200;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return { ok: status >= 200 && status < 300, status } as Response;
    }));
  });

  const connect = (es: FakeEventSource, id: string) => {
    es.open();
    es.emit('connected', { ts: 1, subscriptionId: id });
  };

  it('does not open a second socket for a session watch', () => {
    const a = subscribeAppEvents({ on: { 'live-sessions': () => {} } });
    const b = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(sole().url).toBe('/api/events');
    a(); b();
  });

  it('registers the watch once connected, then fires onWatching(false)', async () => {
    const watching = vi.fn();
    const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: watching });
    await flush();
    expect(calls).toHaveLength(0); // no subscriptionId yet

    connect(sole(), 'sub-1');
    await flush();
    expect(calls).toEqual([{ subscriptionId: 'sub-1', add: [{ sessionId: 's1', project: '/p' }], remove: [] }]);
    expect(watching).toHaveBeenCalledTimes(1);
    expect(watching).toHaveBeenCalledWith(false);
    off();
  });

  it('registers immediately when the socket is already connected', async () => {
    const keep = subscribeAppEvents({});
    connect(sole(), 'sub-1');
    const watching = vi.fn();
    const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: watching });
    await flush();
    expect(calls).toHaveLength(1);
    expect(watching).toHaveBeenCalledWith(false);
    off(); keep();
  });

  it('shares one server watch between subscribers of the same session', async () => {
    const w1 = vi.fn();
    const w2 = vi.fn();
    const a = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: w1 });
    connect(sole(), 'sub-1');
    await flush();
    const b = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: w2 });
    await flush();
    expect(calls).toHaveLength(1);
    expect(w2).toHaveBeenCalledWith(false); // already live: confirmed without a POST

    a();
    await flush();
    expect(calls).toHaveLength(1); // b still watches s1
    b();
  });

  it('removes a session on the server when its last watcher leaves an open socket', async () => {
    const keep = subscribeAppEvents({});
    const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
    connect(sole(), 'sub-1');
    await flush();
    off();
    await flush();
    expect(calls[1]).toEqual({ subscriptionId: 'sub-1', add: [], remove: ['s1'] });
    keep();
  });

  it('sends no remove when leaving closes the socket (the server releases on close)', async () => {
    const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
    const es = sole();
    connect(es, 'sub-1');
    await flush();
    off();
    await flush();
    expect(es.closed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('re-registers under the NEW id after a reconnect and fires onWatching(true)', async () => {
    const watching = vi.fn();
    const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: watching });
    const es = sole();
    connect(es, 'sub-1');
    await flush();

    es.drop();
    await flush();
    expect(watching).toHaveBeenCalledTimes(1); // nothing at the drop

    connect(es, 'sub-2');
    await flush();
    expect(calls[1]).toEqual({ subscriptionId: 'sub-2', add: [{ sessionId: 's1', project: '/p' }], remove: [] });
    expect(watching).toHaveBeenCalledTimes(2);
    expect(watching).toHaveBeenLastCalledWith(true);
    off();
  });

  it('does not retry a 404 (the stream is gone; reconnect re-registers)', async () => {
    status = 404;
    const watching = vi.fn();
    const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: watching });
    connect(sole(), 'sub-1');
    await flush();
    expect(calls).toHaveLength(1);
    expect(watching).not.toHaveBeenCalled();
    off();
  });

  it('runs control POSTs strictly in order', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(JSON.parse(String(init.body)));
      await gate;
      inFlight--;
      return { ok: true, status: 200 } as Response;
    }));

    const keep = subscribeAppEvents({});
    connect(sole(), 'sub-1');
    const a = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
    a(); // remove queued behind the add
    subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } }); // re-add
    await flush();
    expect(calls).toHaveLength(1); // the rest wait for the first
    release();
    await flush();
    expect(maxInFlight).toBe(1);
    expect(calls.map(c => (c.add.length ? 'add' : 'remove'))).toEqual(['add', 'remove', 'add']);
    keep();
  });

  describe('when a control POST fails', () => {
    beforeEach(() => { uiLog.mockClear(); vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('forces a reconnect after exhausting retries, then re-registers and resyncs', async () => {
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        throw new TypeError('network');
      }));
      const watching = vi.fn();
      const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: watching });
      const first = sole();
      connect(first, 'sub-1');
      await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000); // the retry backoff

      expect(calls).toHaveLength(4);
      expect(first.closed).toBe(true);
      expect(uiLog).toHaveBeenCalledWith('warn', 'sse.control', expect.stringContaining('reconnecting'), expect.anything());
      expect(watching).not.toHaveBeenCalled();

      // The server recovers; the forced reopen registers under the new id.
      status = 200;
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return { ok: true, status: 200 } as Response;
      }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      connect(FakeEventSource.instances[1], 'sub-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.at(-1)).toEqual({ subscriptionId: 'sub-2', add: [{ sessionId: 's1', project: '/p' }], remove: [] });
      expect(watching).toHaveBeenCalledTimes(1);
      off();
    });

    it('forces a reconnect on a 404 for the CURRENT id (stream looks alive but the server lost it)', async () => {
      status = 404;
      const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
      const first = sole();
      connect(first, 'sub-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1); // no retries of a 404
      expect(first.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      off();
    });

    it('backs off repeated forced reconnects even though each open succeeds', async () => {
      status = 404;
      const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
      connect(FakeEventSource.instances[0], 'a');
      await vi.advanceTimersByTimeAsync(1_000);
      connect(FakeEventSource.instances[1], 'b');
      await vi.advanceTimersByTimeAsync(1_999);
      expect(FakeEventSource.instances).toHaveLength(2); // second delay is 2s, not 1s
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.instances).toHaveLength(3);
      off();
    });

    it('on 422 confirms the accepted watches, logs the refused ones, and does not reconnect', async () => {
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return {
          ok: false, status: 422,
          json: async () => ({ success: false, rejected: [{ sessionId: 's1', reason: 'limit' }] }),
        } as unknown as Response;
      }));
      const watching = vi.fn();
      const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' }, onWatching: watching });
      const es = sole();
      connect(es, 'sub-1');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toHaveLength(1);
      expect(watching).not.toHaveBeenCalled(); // refused, so NOT confirmed
      expect(es.closed).toBe(false);
      expect(uiLog).toHaveBeenCalledWith('warn', 'sse.control', 'server refused session watch', expect.anything());
      off();
    });

    it('only logs a failed unwatch (the stream close releases it)', async () => {
      const keep = subscribeAppEvents({});
      const off = subscribeAppEvents({ watchSession: { sessionId: 's1', project: '/p' } });
      const es = sole();
      connect(es, 'sub-1');
      await vi.advanceTimersByTimeAsync(0);
      status = 500;
      off();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls.filter(c => c.remove.length)).toHaveLength(4);
      expect(es.closed).toBe(false);
      expect(uiLog).toHaveBeenCalledWith('warn', 'sse.control', 'session unwatch not delivered', expect.anything());
      keep();
    });
  });
});
