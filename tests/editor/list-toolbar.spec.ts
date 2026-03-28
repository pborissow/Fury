import { test, expect, Page, Locator } from '@playwright/test';

// The prompt editor is inside the bottom panel of the vertical split.
// It's the tiptap editor that has a sibling toolbar with the "Bullet List" button.
async function setup(page: Page): Promise<{ editor: Locator; toolbar: Locator }> {
  await page.goto('/');

  // Click the first clickable session in the sidebar
  const firstSession = page.locator('.overflow-y-auto .rounded.border.cursor-pointer').first();
  await firstSession.waitFor({ timeout: 10000 });
  await firstSession.click();

  // Wait for the prompt editor — it's the tiptap editor inside a container that also has
  // a send button (the notes editor doesn't have one).
  const sendButton = page.locator('button[title="Send message"]');
  await sendButton.waitFor({ timeout: 5000 });

  // The editor container wraps both toolbar and editor
  const editorContainer = sendButton.locator('ancestor::div[class*="flex flex-col border"]').first();

  // Target the .tiptap contenteditable inside that container
  const editor = page.locator('.tiptap[contenteditable="true"]').last();
  await editor.waitFor({ timeout: 5000 });

  // The toolbar is the div with buttons above the editor in the same container
  const toolbar = editor.locator('..').locator('..').locator('div').first();

  return { editor, toolbar };
}

async function clickButton(page: Page, title: string) {
  // Find the button by title that's near the prompt editor (not the notes toolbar)
  const buttons = page.locator(`button[title="${title}"]`);
  // Take the last one — notes editor toolbar comes first, prompt editor comes second
  const count = await buttons.count();
  await buttons.nth(count - 1).click();
}

test.describe('RichTextEditor list toolbar', () => {

  test('click bullet button on empty editor creates a bullet list', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    await clickButton(page, 'Bullet List');

    const html = await editor.innerHTML();
    console.log('After clicking bullet on empty editor:', html);
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
  });

  test('click bullet button toggles off when already in bullet list', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    // Toggle on
    await clickButton(page, 'Bullet List');
    let html = await editor.innerHTML();
    console.log('After first bullet click:', html);
    expect(html).toContain('<ul');

    // Move cursor back into the list item, then toggle off
    await editor.press('Home');
    await clickButton(page, 'Bullet List');
    html = await editor.innerHTML();
    console.log('After second bullet click (toggle off):', html);
    expect(html).not.toContain('<ul');
  });

  test('type text then click bullet converts line to bullet', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();
    await page.keyboard.type('hello world');

    await clickButton(page, 'Bullet List');

    const html = await editor.innerHTML();
    console.log('After typing then clicking bullet:', html);
    expect(html).toContain('<ul');
    expect(html).toContain('hello world');
  });

  test('cursor on line then click bullet does not absorb previous paragraph', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    // Type two paragraphs via Shift+Enter (soft break within same <p>)
    await page.keyboard.type('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');

    // Cursor should be on "line two" — click bullet
    await clickButton(page, 'Bullet List');

    const html = await editor.innerHTML();
    console.log('Two soft-break lines, cursor on second, clicked bullet:', html);

    // "line one" should NOT be inside the list — only "line two" should be
    const ulContent = html.match(/<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1] || '';
    console.log('Content inside <ul>:', ulContent);
    expect(ulContent).toContain('line two');
    expect(ulContent).not.toContain('line one');

    // "line one" should remain as a regular paragraph
    expect(html).toContain('line one');
  });

  test('Shift+Enter inside bullet list creates new bullet item', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    // Create bullet list
    await clickButton(page, 'Bullet List');
    await page.keyboard.type('first item');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second item');

    const html = await editor.innerHTML();
    console.log('Two bullet items via Shift+Enter:', html);
    expect(html).toContain('first item');
    expect(html).toContain('second item');

    const liCount = (html.match(/<li/g) || []).length;
    console.log('Number of <li> elements:', liCount);
    expect(liCount).toBe(2);
  });

  test('Shift+Enter on empty bullet item exits list', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    await clickButton(page, 'Bullet List');
    await page.keyboard.type('only item');
    await page.keyboard.press('Shift+Enter');
    // Second Shift+Enter on empty item should exit the list
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('back to paragraph');

    const html = await editor.innerHTML();
    console.log('Exit list via double Shift+Enter:', html);
    expect(html).toContain('only item');
    expect(html).toContain('back to paragraph');

    // "back to paragraph" should be in a <p>, not in the <ul>
    const afterUl = html.split('</ul>')[1] || '';
    console.log('Content after </ul>:', afterUl);
    expect(afterUl).toContain('back to paragraph');
  });

  test('numbered list basic toggle', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    await clickButton(page, 'Numbered List');

    const html = await editor.innerHTML();
    console.log('After clicking numbered list:', html);
    expect(html).toContain('<ol');
  });

  test('select multiple paragraphs and convert to bullet list', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    // Create separate paragraphs — but since Enter submits, we need to
    // set content programmatically
    await page.evaluate(() => {
      // Find the last tiptap editor (prompt editor)
      const editors = document.querySelectorAll('.tiptap[contenteditable="true"]');
      const el = editors[editors.length - 1] as HTMLElement;
      el.innerHTML = '<p>alpha</p><p>beta</p><p>gamma</p>';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Small pause for TipTap to process
    await page.waitForTimeout(200);

    // Select all
    await editor.click();
    await page.keyboard.press('Control+A');

    await clickButton(page, 'Bullet List');

    const html = await editor.innerHTML();
    console.log('Selected 3 paragraphs, clicked bullet:', html);

    const liCount = (html.match(/<li/g) || []).length;
    console.log('Number of <li> elements:', liCount);
    // Expect 3 list items
    expect(liCount).toBe(3);
  });
});
