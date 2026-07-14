import { test, expect } from '@playwright/test';

// The browser's spellcheck squiggles are painted natively and never appear in
// the DOM, so we can't assert "no red underline" directly. Instead we assert
// the observable cause: inline code rendered in the chat editor carries
// spellcheck="false", which is what suppresses the underline under "bg".

test('chat editor disables spellcheck on inline code', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(2000);

  const session = page.locator('.overflow-y-auto .rounded.border.cursor-pointer').first();
  if (!(await session.isVisible({ timeout: 10000 }).catch(() => false))) {
    test.skip(true, 'No session available to open the chat composer');
    return;
  }
  await session.click();

  // The composer editor becomes editable once the transcript finishes loading.
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible({ timeout: 10000 });
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 10000 });

  // Type the example. The backticks trigger TipTap's inline-code input rule,
  // converting the wrapped text into a <code> mark.
  await editor.click();
  await page.keyboard.type('`bg-muted p-3 rounded border`');

  const code = editor.locator('code').first();
  await expect(code).toBeVisible({ timeout: 5000 });
  await expect(code).toHaveText('bg-muted p-3 rounded border');

  // The squiggle-suppressing attribute must be present on the inline code.
  await expect(code).toHaveAttribute('spellcheck', 'false');

  // ...and the inline-code styling (muted pill) must still be applied — the
  // spellcheck attribute and the .tiptap code CSS coexist, they don't clobber
  // each other.
  const style = await code.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius };
  });
  expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(style.bg).not.toBe('transparent');
  expect(style.padding).toBe('2px 4px');       // 0.125rem 0.25rem
  expect(style.borderRadius).toBe('4px');      // 0.25rem

  // Sanity check it's genuinely inline code, not a fenced code block.
  const parentTag = await code.evaluate((el) => el.parentElement?.tagName.toLowerCase());
  expect(parentTag).not.toBe('pre');
});
