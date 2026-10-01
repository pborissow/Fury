/**
 * Click-through from a search hit into Chat — the whole deep-link chain:
 * tab switch, transcript scrolled to the matched turn, and the SIDEBAR
 * REVEAL (ensureSessionLoaded + the sidebar's `reveal` prop scrolling the
 * session card into view with its isViewing highlight).
 *
 * Also the archived case: an archived session must still open (transcript
 * served from the DB archive) while correctly having NO sidebar card —
 * archived sessions are hidden from the sidebar by design.
 */
import { test, expect } from '@playwright/test';
import { createSearchFixture, openSearchTab, searchFor, clearQuery } from './fixture';

const fx = createSearchFixture('open');

test.beforeAll(async () => { await fx.seed(); });
test.afterAll(async () => { await fx.teardown(); });

test.describe('search → chat deep link', () => {
  test('opening a hit reveals the session in the sidebar, scrolled and highlighted', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    // Relevance puts A first; click its FIRST hit (turn 0).
    await page.getByTestId('search-result-card').first().getByTestId('search-hit').first().click();

    // Chat tab took over (the Search panel is visibility-hidden with its tab).
    await expect(page.getByTestId('search-input')).not.toBeVisible();

    // Transcript: the matched turn's bubble is rendered and scrolled on screen.
    const bubble = page.locator('[data-msg-index]').filter({ hasText: fx.MARKER }).first();
    await expect(bubble).toBeVisible({ timeout: 10_000 });
    await expect(bubble).toBeInViewport();

    // Sidebar reveal: A sits 30 days back in the list, so on a real archive it
    // starts below the fold (or beyond the loaded pages) — the reveal must
    // load it, scroll it into view, and the isViewing highlight must mark it.
    const card = page.locator(`[data-session-id="${fx.SESSION_A}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toBeInViewport(); // auto-retries across the smooth scroll
    await expect(card).toHaveClass(/border-primary/);
  });

  test('an archived hit opens from the DB archive, with no sidebar card', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    // B's card is the one wearing the archived badge; open its only hit.
    const cardB = page.getByTestId('search-result-card').filter({ hasText: fx.DISPLAY_B });
    await cardB.getByTestId('search-hit').first().click();

    await expect(page.getByTestId('search-input')).not.toBeVisible();
    // Transcript content arrives via the /api/transcript DB fallback.
    await expect(
      page.locator('[data-msg-index]').filter({ hasText: 'deliberately long archived reply' }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Archived sessions are hidden from the sidebar BY DESIGN (see
    // delete-to-archive.spec.ts trap #1) — the reveal must not resurrect one.
    await expect(page.locator(`[data-session-id="${fx.SESSION_B}"]`)).toHaveCount(0);

    // Tidy the persisted query before leaving.
    await openSearchTab(page);
    await clearQuery(page);
  });
});
