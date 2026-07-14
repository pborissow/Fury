import { test, expect, type Page } from '@playwright/test';

// Verifies the double-click maximize/restore behavior on the shared Dialog,
// exercised through the file preview (CodeViewerDialog) — the same code path
// the intermediary-message and ask-user-question popups reuse, so covering it
// here is enough for all three consumers.

const FILE_CANDIDATES = ['package.json', 'README.md', 'tsconfig.json', 'index.ts', '.gitignore'];

// Open the Files panel for the first session and click a code file to launch
// the preview dialog. Returns false if no session / no openable file exists.
async function openFilePreview(page: Page): Promise<boolean> {
  await page.goto('/');
  await page.waitForTimeout(2000);

  const session = page.locator('.overflow-y-auto .rounded.border.cursor-pointer').first();
  if (!(await session.isVisible({ timeout: 10000 }).catch(() => false))) return false;
  await session.click();

  const filesTab = page.locator('button', { hasText: 'Files' });
  await filesTab.waitFor({ timeout: 5000 });
  await filesTab.click();

  const search = page.locator('input[placeholder="Search files..."]');
  await search.waitFor({ timeout: 10000 });

  // Scope result clicks to the file tree so transcript text can't be mistaken
  // for a file row.
  const fileTree = page.locator('div.flex.flex-col.h-full.select-none');

  for (const name of FILE_CANDIDATES) {
    await search.fill(name);
    await page.waitForTimeout(400);
    const result = fileTree.getByText(name, { exact: true }).first();
    if (await result.isVisible({ timeout: 1000 }).catch(() => false)) {
      await result.click();
      return true;
    }
  }
  return false;
}

// Measure the rendered dialog window (the panel wrapping the draggable header).
async function windowRect(header: ReturnType<Page['locator']>) {
  return header.evaluate((el) => {
    const rect = (el.parentElement as HTMLElement).getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
}

test('file preview dialog maximizes and restores on header double-click', async ({ page }) => {
  const opened = await openFilePreview(page);
  if (!opened) {
    test.skip(true, 'No session with an openable code file was available');
    return;
  }

  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ timeout: 10000 });

  const header = dialog.locator('[data-dialog-header]').first();
  await header.waitFor({ timeout: 5000 });

  const fullViewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const before = await windowRect(header);

  // Double-click the header (left side, clear of the header buttons) to maximize.
  await header.dblclick({ position: { x: 20, y: 12 } });
  await page.waitForTimeout(300);

  const maximized = await windowRect(header);
  // Fills the full viewport (100vw/100vh).
  expect(maximized.w).toBeGreaterThan(before.w);
  expect(maximized.h).toBeGreaterThan(before.h);
  expect(Math.abs(maximized.w - fullViewport.w)).toBeLessThan(2);
  expect(Math.abs(maximized.h - fullViewport.h)).toBeLessThan(2);

  // Dragging is disabled while maximized — the window must not move.
  await page.mouse.move(maximized.x + 40, maximized.y + 12);
  await page.mouse.down();
  await page.mouse.move(maximized.x + 220, maximized.y + 160, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const afterDrag = await windowRect(header);
  expect(Math.abs(afterDrag.x - maximized.x)).toBeLessThan(2);
  expect(Math.abs(afterDrag.y - maximized.y)).toBeLessThan(2);

  // Double-click again to restore the exact prior geometry.
  await header.dblclick({ position: { x: 20, y: 12 } });
  await page.waitForTimeout(300);

  const restored = await windowRect(header);
  expect(Math.abs(restored.w - before.w)).toBeLessThan(2);
  expect(Math.abs(restored.h - before.h)).toBeLessThan(2);
});
