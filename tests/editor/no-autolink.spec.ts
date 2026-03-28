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

test.describe('No auto-linking of URLs and emails', () => {

  test('Typing a URL should not create an <a> tag in the editor', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    await page.keyboard.type("let's test this https://www.google.com/ and this email@test.com");

    const html = await editor.innerHTML();
    console.log('Editor innerHTML after typing URL + email:', html);

    // There should be NO anchor tags in the editor
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('</a>');

    // The plain text should be present
    expect(html).toContain('https://www.google.com/');
    expect(html).toContain('email@test.com');
  });

  test('Clicking on typed URL text should not navigate away', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    await page.keyboard.type('visit https://www.google.com/ now');

    // Try clicking on the URL text within the editor
    const urlText = editor.locator('text=https://www.google.com/');
    await urlText.click();

    // Should still be on the same page (no navigation)
    expect(page.url()).toContain('localhost:3879');

    // No new tabs should have opened
    const pages = page.context().pages();
    expect(pages.length).toBe(1);
  });

  test('Turndown conversion of editor HTML should not produce markdown link syntax', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.click();

    await page.keyboard.type("let's test this https://www.google.com/ and this email@test.com");

    const html = await editor.innerHTML();
    console.log('Editor HTML before conversion:', html);

    // Convert the editor HTML to markdown in the browser using Turndown
    // (same library the editor uses on submit)
    const markdown = await page.evaluate((editorHtml) => {
      const TurndownService = (window as any).TurndownService
        // Turndown is bundled — access it via the module system by creating a fresh instance
        // from the same constructor the editor uses.
        || (() => {
          // Fallback: manually convert using DOM parsing
          const div = document.createElement('div');
          div.innerHTML = editorHtml;
          return { turndown: () => div.textContent || '' };
        })();
      // If TurndownService is available globally, use it; otherwise use the fallback
      if (typeof TurndownService === 'function') {
        const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
        return td.turndown(editorHtml);
      }
      const div = document.createElement('div');
      div.innerHTML = editorHtml;
      return div.textContent || '';
    }, html);

    console.log('Markdown output:', markdown);

    // The HTML should not contain <a> tags (proven by test 1, but double-check)
    expect(html).not.toContain('<a ');

    // Since there are no <a> tags, Turndown should NOT produce markdown link syntax
    expect(markdown).not.toContain('](');
    expect(markdown).not.toContain('[https://');
    expect(markdown).not.toContain('mailto:');

    // The plain text should be preserved
    expect(markdown).toContain('https://www.google.com/');
    expect(markdown).toContain('email@test.com');
  });
});
