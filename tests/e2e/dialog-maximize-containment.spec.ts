/**
 * The AskUserQuestion dialog is anchored to the Chat tab's middle panel
 * (portalContainer = middlePanelRef), so it can float over the conversation
 * without blocking the rest of the app. Maximizing it must fill THAT PANEL — not
 * the viewport. The shipped maximize sized to window.innerWidth/innerHeight
 * regardless of the anchor, and `max-height: 100%` can't claw it back (a
 * percentage max-height against the absolutely-positioned, auto-height Radix
 * Content resolves to `none`). So the dialog overflowed the panel and its own
 * header (close / double-click-to-restore) and footer were dragged out of reach.
 *
 * Reproduced against a real <Dialog/> in /app/dialog-harness — a bounded
 * panel standing in for the middle column, no live Claude turn required.
 */
import { test, expect } from '@playwright/test';

const EPS = 1.5; // sub-pixel layout tolerance

test('maximized dialog stays within its portal container, header reachable', async ({ page }) => {
  await page.goto('/dialog-harness');

  const panel = page.getByTestId('harness-panel');
  const header = page.locator('[data-dialog-header]');
  await expect(header).toBeVisible();

  // Double-click the header to maximize (components/Dialog handleHeaderDoubleClick).
  await header.dblclick();

  // Let layout settle.
  await page.waitForTimeout(100);

  const panelBox = await panel.boundingBox();
  // The card is the dialog surface — the element carrying the header.
  const card = page.locator('[data-dialog-header]').locator('..');
  const cardBox = await card.boundingBox();
  const closeBtn = page.getByRole('button', { name: 'Close' });
  const closeBox = await closeBtn.boundingBox();

  expect(panelBox, 'panel present').not.toBeNull();
  expect(cardBox, 'dialog card present').not.toBeNull();
  expect(closeBox, 'close button present').not.toBeNull();
  if (!panelBox || !cardBox || !closeBox) return;

  // 1. The maximized card is contained by the panel on every edge.
  expect(cardBox.x, 'left edge inside panel').toBeGreaterThanOrEqual(panelBox.x - EPS);
  expect(cardBox.y, 'top edge inside panel').toBeGreaterThanOrEqual(panelBox.y - EPS);
  expect(cardBox.x + cardBox.width, 'right edge inside panel').toBeLessThanOrEqual(
    panelBox.x + panelBox.width + EPS,
  );
  expect(cardBox.y + cardBox.height, 'bottom edge inside panel').toBeLessThanOrEqual(
    panelBox.y + panelBox.height + EPS,
  );

  // 2. The close control's center sits inside the panel, so it's actually
  //    clickable rather than clipped away above the panel's top edge.
  const cx = closeBox.x + closeBox.width / 2;
  const cy = closeBox.y + closeBox.height / 2;
  expect(cx).toBeGreaterThanOrEqual(panelBox.x);
  expect(cx).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  expect(cy).toBeGreaterThanOrEqual(panelBox.y);
  expect(cy).toBeLessThanOrEqual(panelBox.y + panelBox.height);

  // 3. And it can be clicked — closing the dialog (onOpenChange → header gone).
  await closeBtn.click();
  await expect(header).toHaveCount(0);
});
