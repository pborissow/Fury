import { test } from '@playwright/test';

test('debug: list all sidebar sessions', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForTimeout(3000);

  // Use evaluate to scrape all sessions at once — much faster than per-card Playwright locators
  const sessions = await page.evaluate(() => {
    const sidebar = document.querySelector('.overflow-y-auto');
    if (!sidebar) return [];
    const cards = sidebar.querySelectorAll('.rounded.border');
    return Array.from(cards).map((card, i) => {
      const display = card.querySelector('.text-sm.text-foreground')?.textContent || '';
      const project = card.querySelector('.font-mono.truncate')?.textContent || '';
      const hasWarning = !!card.querySelector('.text-yellow-500, .text-orange-500');
      return { i, display: display.substring(0, 100), project: project.substring(0, 50), hasWarning };
    });
  });

  console.log(`Total: ${sessions.length} sessions`);
  for (const s of sessions) {
    const marker = s.hasWarning ? ' [!]' : '';
    const isTrying = s.display.includes('I am trying to send') ? ' <<<' : '';
    console.log(`${s.i + 1}. ${s.display} | ${s.project}${marker}${isTrying}`);
  }
});
