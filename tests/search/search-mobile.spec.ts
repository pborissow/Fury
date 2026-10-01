/**
 * Search on the phone layout — locks in the mobile pass (ticket-mobile-pwa):
 * 16px input (iOS focus-zoom guard), no autofocus (software keyboard), the
 * single-row scrollable filter rail, the stacked card header (path under
 * title), touch-sized controls, and the hero hidden in short landscape
 * viewports where it would push the input below the fold.
 */
import { test, expect, devices } from '@playwright/test';
import { createSearchFixture, openSearchTabMobile, searchFor, clearQuery } from './fixture';

// Device descriptors carry defaultBrowserType, which test.use() rejects inside
// a describe group (it would force a new worker); this suite always runs on
// the configured Chromium/Chrome anyway, so strip it.
const { defaultBrowserType: _p, ...IPHONE_14 } = devices['iPhone 14'];
const { defaultBrowserType: _l, ...IPHONE_14_LANDSCAPE } = devices['iPhone 14 landscape'];

const fx = createSearchFixture('mob');

test.beforeAll(async () => { await fx.seed(); });
test.afterAll(async () => { await fx.teardown(); });

test.describe('phone portrait', () => {
  test.use(IPHONE_14);

  test('landing: hero shows, input is 16px, nothing autofocuses', async ({ page }) => {
    await openSearchTabMobile(page);
    const input = page.getByTestId('search-input');
    // BEFORE touching the input (fill() would steal focus and void the
    // check): autoFocus is skipped on coarse pointers — the software
    // keyboard must not pop over half the viewport on tab open.
    await expect(input).not.toBeFocused();
    // < 16px would make iOS Safari zoom the page on focus.
    await expect(input).toHaveCSS('font-size', '16px');
    // A persisted query (prefs restore it globally) starts the tab in
    // results mode — clear to reach the landing for the hero checks.
    await input.fill('');
    await expect(page.locator('svg[viewBox="0 0 800 260"]')).toBeInViewport();
    // The "/" kbd chip is a hardware-keyboard affordance → hidden on touch
    // (pointer-coarse:hidden — the element still EXISTS, so assert hidden,
    // not absent).
    await expect(page.locator('kbd', { hasText: '/' })).toBeHidden();
  });

  test('results: single-row filter rail, stacked card header, touch targets', async ({ page }) => {
    await openSearchTabMobile(page);
    await searchFor(page, fx.MARKER);

    // Filter rail: one non-wrapping, horizontally scrollable row.
    const rail = page.getByTestId('search-role-toggle').locator('..');
    await expect(rail).toHaveCSS('flex-wrap', 'nowrap');
    await expect(rail).toHaveCSS('overflow-x', 'auto');

    // Card header stacks on the phone: the project path renders BELOW the
    // title instead of truncating to noise beside it.
    const card = page.getByTestId('search-result-card').first();
    const title = card.locator('span.font-semibold');
    // Two SmartPath renders exist (inline desktop one hidden, stacked mobile
    // one visible) — the stacked one is LAST in DOM order.
    const path = card.getByText(/fury-e2e-search/).last();
    await expect(path).toBeVisible();
    const [titleBox, pathBox] = [await title.boundingBox(), await path.boundingBox()];
    expect(pathBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height - 1);

    // Touch targets: segmented buttons grow under pointer-coarse (desktop
    // density is ~20px — regression = this assertion failing).
    const segBtn = page.getByTestId('search-role-toggle').getByRole('button', { name: 'All' });
    expect((await segBtn.boundingBox())!.height).toBeGreaterThanOrEqual(30);

    await clearQuery(page);
  });
});

test.describe('phone landscape', () => {
  test.use(IPHONE_14_LANDSCAPE);

  test('hero hides so the input stays above the fold', async ({ page }) => {
    await openSearchTabMobile(page);
    await expect(page.getByTestId('search-input')).toBeInViewport();
    await expect(page.locator('svg[viewBox="0 0 800 260"]')).not.toBeVisible();
  });
});
