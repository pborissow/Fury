import { describe, it, expect } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

/**
 * Regression: the exported `sdkSessionManager` must always resolve the CURRENT
 * instance on globalThis, never a reference captured at module-evaluation time.
 *
 * A captured binding meant that when the SINGLETON_VERSION block swapped in a
 * replacement, already-evaluated importers kept the OLD instance — so routes
 * disagreed about the same session. Seen live: /api/stream-buffer said
 * isProcessing:true while /api/health said false, and ChatTab's 15s health poll
 * cleared the dots mid-turn and refetched the transcript's partials as
 * intermediary bubbles.
 */
const g = globalThis as unknown as { __sdkSessionManager?: any };

describe('sdkSessionManager export binding', () => {
  it('reflects an instance swapped in after this module was evaluated', () => {
    const original = g.__sdkSessionManager;
    try {
      // Build a fresh manager the same way the SINGLETON_VERSION block does.
      const Ctor = (sdkSessionManager as any).constructor;
      const replacement = new Ctor();
      replacement.getOrCreate('swapped-in-session');

      // Simulate the hot-reload recreate.
      g.__sdkSessionManager = replacement;

      // The import above happened BEFORE the swap. With a captured binding this
      // reads the stale instance and misses the session entirely.
      expect(sdkSessionManager.getManagedSessionIds()).toContain('swapped-in-session');
      expect(sdkSessionManager.isSessionProcessing('swapped-in-session')).toBe(false);
    } finally {
      g.__sdkSessionManager = original;
    }
  });

  it('two importers never diverge across a swap (the route disagreement)', () => {
    const original = g.__sdkSessionManager;
    try {
      const Ctor = (sdkSessionManager as any).constructor;

      // "Route A" resolves through the export before the swap.
      const beforeIds = sdkSessionManager.getManagedSessionIds();
      expect(beforeIds).not.toContain('only-in-new');

      const replacement = new Ctor();
      const s = replacement.getOrCreate('only-in-new');
      s.isProcessing = true;
      g.__sdkSessionManager = replacement;

      // "Route B" resolves after the swap. Both must agree — this is exactly
      // what stream-buffer/health disagreed about.
      expect(sdkSessionManager.isSessionProcessing('only-in-new'), 'both importers must see the live instance').toBe(true);
    } finally {
      g.__sdkSessionManager = original;
    }
  });
});
