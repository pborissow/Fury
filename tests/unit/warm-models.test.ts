import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

// warmModels()/spawnWarmQuery()/sessions are private; drive them directly so
// this stays a fast unit test that never spawns a real CLI subprocess.
// The exported singleton is a Proxy that forwards to a globalThis-held instance
// and returns freshly-bound methods per access — so spies must target the REAL
// instance's prototype, where `this.spawnWarmQuery()` actually resolves. Reads
// and writes of private fields still go through the proxy (its get/set forward).
const mgr = sdkSessionManager as any;
const live = (globalThis as any).__sdkSessionManager;
const proto = Object.getPrototypeOf(live);

const CATALOG = [
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Most capable' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Balanced' },
];

beforeEach(() => {
  mgr.lastKnownModels = null;
  mgr.warmPromise = null;
  mgr.sessions.clear();
  vi.restoreAllMocks();
});

describe('sdkSessionManager.warmModels', () => {
  it('returns the cached catalog without spawning when lastKnownModels is set', async () => {
    mgr.lastKnownModels = CATALOG;
    const spawn = vi.spyOn(proto, 'spawnWarmQuery');

    const models = await mgr.warmModels();

    expect(models).toEqual(CATALOG);
    expect(spawn, 'a cached catalog must never spawn a throwaway query').not.toHaveBeenCalled();
  });

  it('reuses a live session query (no spawn) and caches the result', async () => {
    const supportedModels = vi.fn().mockResolvedValue(CATALOG);
    mgr.sessions.set('s1', { q: { supportedModels } });
    const spawn = vi.spyOn(proto, 'spawnWarmQuery');

    const models = await mgr.warmModels();

    expect(models).toEqual(CATALOG);
    expect(supportedModels).toHaveBeenCalledOnce();
    expect(mgr.lastKnownModels, 'a warmed catalog is cached for the next open').toEqual(CATALOG);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls through to a throwaway spawn when the only live query throws', async () => {
    mgr.sessions.set('s1', { q: { supportedModels: vi.fn().mockRejectedValue(new Error('nope')) } });
    const spawn = vi.spyOn(proto, 'spawnWarmQuery').mockResolvedValue(CATALOG);

    const models = await mgr.warmModels();

    expect(models).toEqual(CATALOG);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('single-flights the throwaway spawn across concurrent callers', async () => {
    let resolveSpawn!: (v: unknown) => void;
    const spawn = vi
      .spyOn(proto, 'spawnWarmQuery')
      .mockImplementation(() => new Promise((r) => { resolveSpawn = r as (v: unknown) => void; }));

    const p1 = mgr.warmModels();
    const p2 = mgr.warmModels();
    resolveSpawn(CATALOG);
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toEqual(CATALOG);
    expect(b).toEqual(CATALOG);
    expect(spawn, 'concurrent opens must share one spawn').toHaveBeenCalledOnce();
  });

  it('clears the single-flight guard so a later cold open can warm again', async () => {
    const spawn = vi.spyOn(proto, 'spawnWarmQuery').mockResolvedValue(CATALOG);

    await mgr.warmModels();
    expect(mgr.warmPromise, 'guard is released after the spawn settles').toBeNull();

    await mgr.warmModels();
    expect(spawn, 'a fresh cold open spawns again (no cache was set by the mock)').toHaveBeenCalledTimes(2);
  });
});
