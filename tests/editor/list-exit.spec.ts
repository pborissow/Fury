import { test, expect, Page, Locator } from '@playwright/test';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const firstSession = page.locator('.overflow-y-auto .rounded.border.cursor-pointer').first();
  await firstSession.waitFor({ timeout: 10000 });
  await firstSession.click();
  const editor = page.locator('.tiptap[contenteditable="true"]').last();
  await editor.waitFor({ timeout: 5000 });
  return { editor };
}

async function clickButton(page: Page, title: string) {
  const buttons = page.locator(`button[title="${title}"]`);
  const count = await buttons.count();
  await buttons.nth(count - 1).click();
}

test.describe('Exiting list mode', () => {

  test('Shift+Enter on last bullet exits list, keeps existing items', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    // Create a bullet list with two items using Shift+Enter
    await clickButton(page, 'Bullet List');
    await page.keyboard.type('item one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('item two');

    // Shift+Enter on non-empty creates new item; another Shift+Enter on empty exits
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('not a bullet');

    const html = await editor.innerHTML();
    console.log('After Shift+Enter exit from list:', html);

    // Both original items should still be bullets
    const ulContent = html.match(/<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1] || '';
    expect(ulContent).toContain('item one');
    expect(ulContent).toContain('item two');

    // The new text should NOT be in the list
    expect(ulContent).not.toContain('not a bullet');

    // The new text should be in a regular paragraph after the list
    const afterUl = html.split('</ul>').pop() || '';
    expect(afterUl).toContain('not a bullet');
  });

  test('Click bullet button to exit list keeps all previous items intact', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    // Create a bullet list with one item, Shift+Enter for new empty item, then click bullet to exit
    await clickButton(page, 'Bullet List');
    await page.keyboard.type('only item');
    await page.keyboard.press('Shift+Enter');
    // Now on empty second bullet — click bullet button to deactivate
    await clickButton(page, 'Bullet List');
    await page.keyboard.type('paragraph text');

    const html = await editor.innerHTML();
    console.log('Exit via button on empty item:', html);

    // "only item" should be in the list
    const ulContent = html.match(/<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1] || '';
    expect(ulContent).toContain('only item');

    // "paragraph text" should NOT be in the list
    expect(ulContent).not.toContain('paragraph text');
    const afterUl = html.split('</ul>').pop() || '';
    expect(afterUl).toContain('paragraph text');
  });
});
