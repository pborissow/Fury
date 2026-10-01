/**
 * Search filters: role, archived, project, sort — each must actually change
 * the result set / order, not just toggle its own pixels.
 */
import { test, expect } from '@playwright/test';
import { createSearchFixture, openSearchTab, searchFor, clearQuery } from './fixture';

const fx = createSearchFixture('filt');

test.beforeAll(async () => { await fx.seed(); });
test.afterAll(async () => { await fx.teardown(); });

/** Reset every filter this spec touches, then clear the query — filter prefs
 *  persist (state.json), so leftovers would leak into the developer's next
 *  real search AND into the other tests of this file. */
async function resetFilters(page: import('@playwright/test').Page) {
  await page.getByTestId('search-role-toggle').getByRole('button', { name: 'All' }).click();
  const archived = page.getByTestId('search-archived-toggle');
  if ((await archived.getAttribute('aria-pressed')) === 'false') await archived.click();
  await clearQuery(page);
}

test.describe('search filters', () => {
  test('excluding archived drops the archived session', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);
    await expect(page.getByTestId('search-result-count')).toContainText('5 matches in 2 sessions');

    await page.getByTestId('search-archived-toggle').click();
    await expect(page.getByTestId('search-result-count')).toContainText('4 matches in 1 session');
    await expect(page.getByTestId('archived-badge')).toHaveCount(0);

    // And back.
    await page.getByTestId('search-archived-toggle').click();
    await expect(page.getByTestId('search-result-count')).toContainText('5 matches in 2 sessions');
    await resetFilters(page);
  });

  test('role filter narrows to You / Claude hits', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    // You → A's 2 user messages only (B's lone message is assistant).
    await page.getByTestId('search-role-toggle').getByRole('button', { name: 'You' }).click();
    await expect(page.getByTestId('search-result-count')).toContainText('2 matches in 1 session');
    for (const accent of await page.getByTestId('hit-role-accent').all()) {
      expect(await accent.getAttribute('data-role')).toBe('user');
    }

    // Claude → A's 2 assistant messages + B's 1.
    await page.getByTestId('search-role-toggle').getByRole('button', { name: 'Claude' }).click();
    await expect(page.getByTestId('search-result-count')).toContainText('3 matches in 2 sessions');
    for (const accent of await page.getByTestId('hit-role-accent').all()) {
      expect(await accent.getAttribute('data-role')).toBe('assistant');
    }
    await resetFilters(page);
  });

  test('project filter narrows to one project', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    // The two fixture projects guarantee corpus.projects.length > 1, so the
    // select is always rendered regardless of the developer's real data.
    const select = page.locator('select[aria-label="Project"]');
    await expect(select).toBeVisible();
    await select.selectOption(fx.PROJECT_A);
    await expect(page.getByTestId('search-result-count')).toContainText('4 matches in 1 session');
    await expect(page.getByText(fx.DISPLAY_B)).not.toBeVisible();

    await select.selectOption('all');
    await expect(page.getByTestId('search-result-count')).toContainText('5 matches in 2 sessions');
    await resetFilters(page);
  });

  test('sort toggles between relevance and recency order', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);

    const firstTitle = page.getByTestId('search-result-card').first().locator('span.font-semibold');
    // Relevance (default): A first — its opener repeats the marker 3×.
    await expect(firstTitle).toHaveText(fx.DISPLAY_A);
    // Recent: B first — it was updated today, A 30 days ago.
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await expect(firstTitle).toHaveText(fx.DISPLAY_B);
    // And back (also resets the persisted sort pref).
    await page.getByRole('button', { name: 'Relevance', exact: true }).click();
    await expect(firstTitle).toHaveText(fx.DISPLAY_A);
    await resetFilters(page);
  });
});
