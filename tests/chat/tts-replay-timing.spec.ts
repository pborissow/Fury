import { test, expect } from '@playwright/test';
import { findSessionInSidebar } from '../live-sessions/find-session';

test.setTimeout(60_000);

test('replay is instant after first play', async ({ page }) => {
  // Enable TTS
  await page.request.post('/api/settings', { data: { ttsEnabled: true } });
  await page.goto('/');

  // Track TTS API calls and timing
  let callCount = 0;
  const callTimes: number[] = [];
  const emptyWav = Buffer.from(
    'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
    'base64',
  );
  await page.route('**/api/tts', async (route) => {
    callCount++;
    callTimes.push(Date.now());
    console.log(`[TTS API] call #${callCount}`);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: emptyWav });
  });

  await page.waitForTimeout(1000);

  // Find a session with Claude responses (skip index 0 which may be active)
  const sidebar = page.locator('.overflow-y-auto').first();
  const cards = sidebar.locator('.rounded.border');
  await cards.first().waitFor({ timeout: 10_000 });
  let found = false;
  for (let i = 1; i < Math.min(await cards.count(), 10); i++) {
    await cards.nth(i).click();
    await page.waitForTimeout(1500);
    const hasClaude = await page.locator('.group\\/bubble').filter({ hasText: 'Claude' }).count();
    if (hasClaude > 0) { found = true; console.log(`Using session at index ${i}`); break; }
  }
  expect(found, 'No session with Claude responses found').toBe(true);
  await page.waitForTimeout(2000);

  // First click — generates audio (API call)
  const playBtn = page.locator('button[title="Play audio"], button[title="Stop audio"]').last();
  await expect(playBtn).toBeVisible({ timeout: 5000 });

  const t1 = Date.now();
  await playBtn.click();
  await expect(async () => expect(callCount).toBe(1)).toPass({ timeout: 10_000 });
  console.log(`First play: triggered API call in ${Date.now() - t1}ms`);

  // Wait for audio to "finish" (tiny WAV)
  await expect(page.locator('button[title="Play audio"]').last()).toBeVisible({ timeout: 5000 });

  // Second click — should replay from cache (NO API call)
  const replayBtn = page.locator('button[title="Play audio"]').last();
  const t2 = Date.now();
  await replayBtn.click();

  // Give it a moment, then verify no new API call was made
  await page.waitForTimeout(300);
  console.log(`Replay: ${Date.now() - t2}ms, API calls: ${callCount}`);
  expect(callCount).toBe(1);

  // Cleanup
  await page.request.post('/api/settings', { data: { ttsEnabled: false } });
});
