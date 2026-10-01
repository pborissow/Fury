/**
 * Search core loop: type → debounced results → highlighted snippets →
 * expander → clear → hero returns.
 *
 * Covers the regressions this UI has actually had: gray-on-gray highlights
 * (now the --highlight amber mark), the \u0001/\u0002 marker parsing in
 * Snippet.tsx (fragile to edit — see its history), and the hero's
 * mount/unmount → fade transition.
 */
import { test, expect } from '@playwright/test';
import { createSearchFixture, openSearchTab, searchFor, clearQuery } from './fixture';

const fx = createSearchFixture('flow');

test.beforeAll(async () => { await fx.seed(); });
test.afterAll(async () => { await fx.teardown(); });

test.describe('search flow', () => {
  test('typing a query renders counted, highlighted results', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    // 4 hits in A + 1 in B.
    await expect(page.getByTestId('search-result-count')).toContainText('5 matches in 2 sessions');
    await expect(page.getByTestId('search-result-card')).toHaveCount(2);

    // Both fixture sessions present; B wears its archived badge. Scoped to
    // the Search tab — session A ALSO renders in the (hidden) Chat sidebar,
    // and an unscoped getByText trips strict mode on it.
    const searchTab = page.getByTestId('search-tab');
    await expect(searchTab.getByText(fx.DISPLAY_A)).toBeVisible();
    await expect(searchTab.getByText(fx.DISPLAY_B)).toBeVisible();
    await expect(page.getByTestId('archived-badge')).toHaveCount(1);

    // Highlights: the matched tokens render as <mark>s (the \u0001/\u0002
    // boundary parsing), and ADJACENT matches separated only by whitespace
    // merge into ONE mark — A's top hit opens with the marker 3×, so its
    // first mark must hold the whole merged phrase, not a chopped pill.
    const firstMark = page.getByTestId('search-hit').first().locator('mark').first();
    await expect(firstMark).toBeVisible();
    await expect(firstMark).toHaveText(`${fx.MARKER} ${fx.MARKER} ${fx.MARKER}`);
    // And a single-occurrence hit marks exactly the token.
    const secondMark = page.getByTestId('search-hit').nth(1).locator('mark').first();
    await expect(secondMark).toHaveText(fx.MARKER);
  });

  test('collapsed cards expand to all hits', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    // A has 4 hits, COLLAPSED_HITS = 2 → "2 more matches" expander.
    const expand = page.getByTestId('search-expand');
    await expect(expand).toHaveText(/2 more matches in this session/);
    await expand.click();
    // All 5 hits now visible (A's 4 + B's 1); the expander is gone.
    await expect(page.getByTestId('search-hit')).toHaveCount(5);
    await expect(page.getByTestId('search-expand')).toHaveCount(0);
  });

  test('clearing the query restores the hero landing', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    const hero = page.locator('svg[viewBox="0 0 800 260"]');
    // Results mode: hero collapsed/faded out of view.
    await expect(hero).not.toBeInViewport();

    await clearQuery(page);
    await expect(hero).toBeInViewport();
    await expect(page.getByTestId('search-result-count')).not.toBeVisible();
  });
});
