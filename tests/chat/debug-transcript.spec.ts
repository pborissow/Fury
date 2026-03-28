import { test, expect } from '@playwright/test';

test('check march 15 sessions', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(3000);

  const historyRes = await page.evaluate(() =>
    fetch('/api/history').then(r => r.json())
  );

  // Find March 15 sessions
  const entries = historyRes.entries || [];
  const mar15 = entries.filter((s: any) => {
    const d = new Date(s.timestamp);
    return d.getMonth() === 2 && d.getDate() === 15; // March = 2
  });

  console.log(`March 15 sessions:`);
  for (const s of mar15) {
    const date = new Date(s.timestamp).toLocaleString();
    console.log(`  ID: ${s.sessionId} | ${date} | ${s.messageCount} msgs | "${s.display?.substring(0, 80)}"`);

    // Test transcript for each
    const res = await page.evaluate(({ sid, proj }) =>
      fetch(`/api/transcript?sessionId=${encodeURIComponent(sid)}&project=${encodeURIComponent(proj)}`)
        .then(r => r.json()),
      { sid: s.sessionId, proj: s.project }
    );

    console.log(`    -> messages: ${res.messages?.length}, partial: ${res.partial}`);
    if (res.messages) {
      for (const m of res.messages.slice(0, 5)) {
        console.log(`    [${m.role}]: "${m.content?.substring(0, 80)}"`);
      }
    }
  }
});
