import { test, expect } from '@playwright/test';
import { findSessionInSidebar, findStuckSession } from './find-session';

/**
 * Regression test: when a session's health reports isStuck=true (e.g. the
 * Claude process is hung because orphaned child processes keep it alive on
 * Windows), the frontend should not show permanent bouncing dots.
 *
 * Root cause: every code path that clears transcriptLoading requires
 * isProcessing=false from the health/stream-buffer API, but a stuck
 * claude.exe process never exits, so isProcessing stays true forever.
 */
test.describe('Stuck session handling', () => {

  test('health API correctly identifies stuck sessions', async ({ request }) => {
    const historyRes = await request.get('/api/history');
    const history = await historyRes.json();

    let stuckHealth: any = null;
    for (const entry of (history.entries?.slice(0, 15) || [])) {
      if (!entry.sessionId) continue;
      const healthRes = await request.get(
        `/api/health?sessionId=${encodeURIComponent(entry.sessionId)}`
      );
      if (!healthRes.ok()) continue;
      const health = await healthRes.json();
      if (health.isProcessing && health.isStuck) {
        stuckHealth = health;
        break;
      }
    }

    test.skip(!stuckHealth, 'No stuck session currently exists to test against');

    expect(stuckHealth.isProcessing).toBe(true);
    expect(stuckHealth.isStuck).toBe(true);
    expect(stuckHealth.stuckReason).toBeTruthy();
  });

  test('stream-buffer reports stuck session as still active (bug)', async ({ request }) => {
    const historyRes = await request.get('/api/history');
    const history = await historyRes.json();

    let stuckSessionId: string | null = null;
    for (const entry of (history.entries?.slice(0, 15) || [])) {
      if (!entry.sessionId) continue;
      const healthRes = await request.get(
        `/api/health?sessionId=${encodeURIComponent(entry.sessionId)}`
      );
      if (!healthRes.ok()) continue;
      const health = await healthRes.json();
      if (health.isProcessing && health.isStuck) {
        stuckSessionId = entry.sessionId;
        break;
      }
    }

    test.skip(!stuckSessionId, 'No stuck session currently exists to test against');

    const bufRes = await request.get(
      `/api/stream-buffer?sessionId=${encodeURIComponent(stuckSessionId!)}`
    );
    expect(bufRes.ok()).toBe(true);
    const buf = await bufRes.json();

    // Document the bug: both isProcessing and isActive stay true for a
    // stuck session, which causes the frontend to show bouncing dots forever.
    // After a fix, at least one of these should be false so the frontend
    // can resolve the loading state.
    const stuckForever = buf.isProcessing && buf.isActive;
    expect.soft(
      stuckForever,
      'BUG: stuck session has isProcessing=true AND isActive=true — ' +
      'frontend will show bouncing dots forever because every code path ' +
      'that clears transcriptLoading requires isProcessing=false'
    ).toBe(false);
  });

  test('clicking a stuck session does not show permanent bouncing dots', async ({ page }) => {
    const stuck = await findStuckSession(page);
    test.skip(!stuck, 'No stuck session currently exists to test against');

    await page.goto('/');

    // Find the session using label, display text, or sessionId as fallbacks
    const card = await findSessionInSidebar(page, {
      label: stuck!.label,
      displayText: stuck!.display.substring(0, 30),
      sessionId: stuck!.sessionId,
    });
    test.skip(!card, 'Stuck session not found in sidebar');

    await card!.click();

    // Wait for health/stream-buffer checks to complete
    await page.waitForTimeout(3_000);

    // The bouncing dots indicator (three dot divs)
    const bouncingDots = page.locator('.dot.rounded-full.bg-primary');
    const dotsVisible = await bouncingDots.first().isVisible().catch(() => false);

    if (dotsVisible) {
      // Dots are showing — assert that a stuck/error indicator is also
      // visible so the user knows the session is hung (not just slow).
      const stuckIndicator = page.locator('text=/stuck|timed out|not responding/i');
      const hasStuckUI = await stuckIndicator.count() > 0;

      expect.soft(
        hasStuckUI,
        'Stuck session shows bouncing dots but no stuck/error indicator — ' +
        'user has no way to know the session is hung'
      ).toBe(true);
    }
  });
});
