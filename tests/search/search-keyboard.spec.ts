/**
 * Search keyboard flows: "/" focuses the box, ↑/↓ move the selection ring
 * across hit rows, Enter opens the selection, Esc clears the query.
 */
import { test, expect } from '@playwright/test';
import { createSearchFixture, openSearchTab, searchFor, clearQuery } from './fixture';

const fx = createSearchFixture('kbd');

test.beforeAll(async () => { await fx.seed(); });
test.afterAll(async () => { await fx.teardown(); });

test.describe('search keyboard', () => {
  test('"/" focuses the search box from anywhere in the tab', async ({ page }) => {
    await openSearchTab(page);
    const input = page.getByTestId('search-input');
    // A persisted query may have been restored; start from a known-empty box,
    // then blur it (it autofocuses on desktop, and fill() focuses too).
    await input.fill('');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(input).not.toBeFocused();
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    // The shortcut must not have typed a literal "/" into the box.
    await expect(input).toHaveValue('');
  });

  test('arrow keys move the ring; Enter opens the selection', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);
    const hits = page.getByTestId('search-hit');
    await expect(hits.first()).toBeVisible();

    await page.getByTestId('search-input').focus();
    await page.keyboard.press('ArrowDown');
    await expect(hits.nth(0)).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(hits.nth(1)).toHaveAttribute('data-selected', 'true');
    await expect(hits.nth(0)).not.toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(hits.nth(0)).toHaveAttribute('data-selected', 'true');

    // Enter opens the selected hit in Chat: the Search panel goes
    // visibility-hidden and the fixture turn renders in the transcript.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('search-input')).not.toBeVisible();
    await expect(
      page.locator('[data-msg-index]').filter({ hasText: fx.MARKER }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Esc clears the query', async ({ page }) => {
    await openSearchTab(page);
    await searchFor(page, fx.MARKER);
    await page.getByTestId('search-input').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('search-input')).toHaveValue('');
    await clearQuery(page); // persist the cleared query
  });
});
