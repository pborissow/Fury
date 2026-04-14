import { test, expect } from '@playwright/test';
import { findSessionInSidebar } from '../live-sessions/find-session';

/** Intercept /api/tts — returns a tiny valid WAV and tracks call count. */
function interceptTts(page: import('@playwright/test').Page) {
  let callCount = 0;
  let lastText = '';
  const emptyWav = Buffer.from(
    'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
    'base64',
  );
  page.route('**/api/tts', async (route) => {
    callCount++;
    const body = route.request().postDataJSON();
    lastText = body?.text ?? '';
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: emptyWav });
  });
  return { getCallCount: () => callCount, getLastText: () => lastText };
}

async function setTts(page: import('@playwright/test').Page, enabled: boolean) {
  // Set via direct API call (no page context needed)
  await page.request.post('/api/settings', {
    data: { ttsEnabled: enabled },
  });
}

/** Click the first sidebar session that has at least one Claude bubble. */
async function openSessionWithClaudeResponse(page: import('@playwright/test').Page) {
  const sidebar = page.locator('.overflow-y-auto').first();
  const cards = sidebar.locator('.rounded.border');
  await cards.first().waitFor({ timeout: 10_000 });

  const count = await cards.count();
  // Skip index 0 — it may be the active Claude Code session
  for (let i = 1; i < Math.min(count, 10); i++) {
    await cards.nth(i).click();
    await page.waitForTimeout(1500);
    const bubbles = page.locator('.group\\/bubble').filter({ hasText: 'Claude' });
    const bubbleCount = await bubbles.count();
    if (bubbleCount > 0) {
      // Verify the last turn has an assistant message (not just user)
      const lastBubble = bubbles.last();
      const text = await lastBubble.locator('.overflow-x-auto').innerText().catch(() => '');
      if (text.length > 10) {
        console.log(`Using session at index ${i} with ${bubbleCount} Claude bubbles`);
        return true;
      }
    }
  }
  return false;
}

const ttsButtonLocator = (page: import('@playwright/test').Page) =>
  page.locator('.group\\/bubble').filter({ hasText: 'Claude' }).last()
    .locator('button[title="Play audio"], button[title="Stop audio"]');

test.setTimeout(30_000);

test('TTS button appears on last Claude bubble when enabled', async ({ page }) => {
  await setTts(page, true);
  await page.goto('/');
  interceptTts(page);
  await page.waitForTimeout(1000);

  const found = await openSessionWithClaudeResponse(page);
  expect(found, 'No session with a Claude response found').toBe(true);

  const btn = ttsButtonLocator(page);
  await expect(btn).toBeVisible({ timeout: 3000 });

  await setTts(page, false);
});

test('clicking TTS button triggers API call with bubble content', async ({ page }) => {
  await setTts(page, true);
  await page.goto('/');
  const { getCallCount, getLastText } = interceptTts(page);
  await page.waitForTimeout(1000);

  const found = await openSessionWithClaudeResponse(page);
  expect(found).toBe(true);

  // Get the bubble text before clicking
  const claudeBubbles = page.locator('.group\\/bubble').filter({ hasText: 'Claude' });
  const lastBubbleText = await claudeBubbles.last().locator('.overflow-x-auto').innerText();
  console.log('[Last bubble]:', lastBubbleText.substring(0, 150));

  // Click the TTS button
  const btn = ttsButtonLocator(page);
  await expect(btn).toBeVisible({ timeout: 3000 });
  await btn.click();

  // Wait for TTS API call
  await expect(async () => {
    expect(getCallCount()).toBe(1);
  }).toPass({ timeout: 5000 });

  // Verify meaningful words match
  const ttsText = getLastText();
  console.log('[TTS text]:', ttsText.substring(0, 150));

  const bubbleWords = new Set(lastBubbleText.toLowerCase().match(/[a-z]{4,}/g) || []);
  const ttsLower = ttsText.toLowerCase();
  const matched = [...bubbleWords].filter(w => ttsLower.includes(w));
  const ratio = bubbleWords.size > 0 ? matched.length / bubbleWords.size : 0;
  console.log(`Word match: ${matched.length}/${bubbleWords.size} (${(ratio * 100).toFixed(0)}%)`);
  expect(ratio).toBeGreaterThanOrEqual(0.8);

  await setTts(page, false);
});

test('replay uses cached audio without re-fetching', async ({ page }) => {
  await setTts(page, true);
  await page.goto('/');
  const { getCallCount } = interceptTts(page);
  await page.waitForTimeout(1000);

  const found = await openSessionWithClaudeResponse(page);
  expect(found).toBe(true);

  // First click — triggers TTS API call
  const btn = ttsButtonLocator(page);
  await expect(btn).toBeVisible({ timeout: 3000 });
  await btn.click();

  await expect(async () => {
    expect(getCallCount()).toBe(1);
  }).toPass({ timeout: 5000 });

  // Wait for fake audio to finish (tiny WAV = instant)
  // The button should return to "Play audio" state
  await expect(page.locator('button[title="Play audio"]').last()).toBeVisible({ timeout: 3000 });

  // Second click — replay from cache
  await page.locator('button[title="Play audio"]').last().click();
  await page.waitForTimeout(500);

  // Should NOT have made another API call
  expect(getCallCount()).toBe(1);
  console.log('Replay used cached audio — no additional API call');

  await setTts(page, false);
});

test('TTS button hidden when feature is disabled', async ({ page }) => {
  await setTts(page, false);
  await page.goto('/');
  await page.waitForTimeout(1000);

  const found = await openSessionWithClaudeResponse(page);
  expect(found).toBe(true);

  // No TTS buttons should exist
  const btn = ttsButtonLocator(page);
  await expect(btn).not.toBeVisible({ timeout: 2000 });
});
