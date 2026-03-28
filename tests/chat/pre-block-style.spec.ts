import { test, expect } from '@playwright/test';

test('pre blocks in assistant chat bubbles have visible background', async ({ page }) => {
  await page.goto('/');

  // Click the first session to load a transcript
  const firstSession = page.locator('.overflow-y-auto .rounded.border.cursor-pointer').first();
  await firstSession.waitFor({ timeout: 10000 });
  await firstSession.click();

  // Wait for transcript to load — look for any assistant bubble with a code block
  const proseChat = page.locator('.prose-chat');
  await proseChat.first().waitFor({ timeout: 10000 });

  // Find a pre element inside a chat bubble
  const preBlock = page.locator('.prose-chat pre').first();
  const preExists = await preBlock.count() > 0;

  if (!preExists) {
    console.log('No pre blocks found in the transcript. Skipping visual check.');
    return;
  }

  // Get computed styles of the pre block
  const styles = await preBlock.evaluate((el) => {
    const computed = window.getComputedStyle(el);
    return {
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderColor,
      borderWidth: computed.borderWidth,
      color: computed.color,
    };
  });
  console.log('Pre block computed styles:', JSON.stringify(styles, null, 2));

  // The pre background should not be transparent
  expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.backgroundColor).not.toBe('transparent');

  // Also check if highlight.js classes are applied inside the pre > code
  const codeBlock = preBlock.locator('code').first();
  if (await codeBlock.count() > 0) {
    const codeClasses = await codeBlock.getAttribute('class');
    console.log('Code block classes:', codeClasses);
    const codeStyles = await codeBlock.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
        color: computed.color,
      };
    });
    console.log('Code block computed styles:', JSON.stringify(codeStyles, null, 2));
  }
});
