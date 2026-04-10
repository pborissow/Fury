import { test, expect } from '@playwright/test';

/**
 * Compaction detection tests.
 *
 * Uses two known sessions:
 *  - A session that *talks about* compaction but has no real compaction event.
 *  - A session that genuinely underwent context compaction (once).
 *
 * Verifies:
 *  1. No false positive — quoting the compaction string doesn't trigger detection.
 *  2. True positive — real compaction messages are hidden and counted.
 *  3. History API — compacted sessions have numCompactions in metadata.
 *  4. UI — compacted sessions render the warning icon with count on hover.
 */

// This session discusses compaction (the string appears in user prompts and
// assistant responses) but never actually compacted.
const NO_COMPACTION_SESSION = {
  sessionId: '0c36e41c-8feb-440d-a4fe-e0bcb0615173',
  project: 'U:\\petya\\Documents\\JavaScript\\Fury',
};

// This session genuinely ran out of context and was compacted (1 time).
const COMPACTED_SESSION = {
  sessionId: 'fb72d784-acbf-45a7-a74b-5d111510b3d6',
  project: 'U:\\petya\\Documents\\JavaScript\\Fury',
};

function fetchTranscript(page: import('@playwright/test').Page, session: { sessionId: string; project: string }) {
  return page.evaluate(
    ({ sid, proj }) =>
      fetch(`/api/transcript?sessionId=${encodeURIComponent(sid)}&project=${encodeURIComponent(proj)}`)
        .then(r => r.json()),
    { sid: session.sessionId, proj: session.project },
  );
}

test.describe('compaction detection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('no false positive when compaction string is merely quoted in messages', async ({ page }) => {
    const data = await fetchTranscript(page, NO_COMPACTION_SESSION);

    expect(data.numCompactions).toBe(0);

    // The user message quoting the compaction string should still be present
    const userMessages = (data.messages as any[]).filter((m: any) => m.role === 'user');
    const quotingMsg = userMessages.find((m: any) =>
      m.content.includes('This session is being continued from a previous conversation'),
    );
    expect(quotingMsg).toBeTruthy();

    // Assistant responses that mention/explain compaction should also be present
    const assistantMessages = (data.messages as any[]).filter((m: any) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);
  });

  test('real compaction event is detected and hidden', async ({ page }) => {
    const data = await fetchTranscript(page, COMPACTED_SESSION);

    expect(data.numCompactions).toBe(1);

    // The compaction summary message should not appear in the messages array
    const allMessages = data.messages as any[];
    const compactionMsg = allMessages.find((m: any) =>
      m.content.startsWith('This session is being continued from a previous conversation that ran out of context'),
    );
    expect(compactionMsg).toBeUndefined();

    // But there should still be real user and assistant messages
    const userMessages = allMessages.filter((m: any) => m.role === 'user');
    const assistantMessages = allMessages.filter((m: any) => m.role === 'assistant');
    expect(userMessages.length).toBeGreaterThan(0);
    expect(assistantMessages.length).toBeGreaterThan(0);
  });

  test('history API returns numCompactions in session metadata', async ({ page }) => {
    const historyRes = await page.evaluate(() =>
      fetch('/api/history').then(r => r.json()),
    );
    const entries = historyRes.entries || [];

    // The compacted session should have numCompactions >= 1 in metadata
    const compacted = entries.find((e: any) => e.sessionId === COMPACTED_SESSION.sessionId);
    expect(compacted, 'compacted session should be in history').toBeTruthy();
    expect(compacted.metadata?.numCompactions).toBe(1);

    // The non-compacted session should NOT have numCompactions
    const notCompacted = entries.find((e: any) => e.sessionId === NO_COMPACTION_SESSION.sessionId);
    expect(notCompacted, 'non-compacted session should be in history').toBeTruthy();
    expect(notCompacted.metadata?.numCompactions).toBeFalsy();
  });

  test('compaction warning icon with count visible in sidebar', async ({ page }) => {
    // The compacted session should show the orange warning icon with count tooltip
    // immediately (metadata comes from the history API, not from loading the transcript).
    const result = await page.evaluate((targetDisplay) => {
      const sidebar = document.querySelector('.overflow-y-auto');
      if (!sidebar) return { found: false, hasIcon: false, title: '' };
      const cards = sidebar.querySelectorAll('.rounded.border');
      for (const card of cards) {
        const display = card.querySelector('.text-sm.text-foreground')?.textContent || '';
        if (display.includes(targetDisplay)) {
          const icon = card.querySelector('.text-orange-500');
          const titleSpan = icon?.closest('span[title]');
          return { found: true, hasIcon: !!icon, title: titleSpan?.getAttribute('title') || '' };
        }
      }
      return { found: false, hasIcon: false, title: '' };
    }, 'I am trying to send a prompt');

    expect(result.found, 'compacted session card should be in sidebar').toBe(true);
    expect(result.hasIcon, 'compaction warning icon should be visible').toBe(true);
    expect(result.title).toBe('Context compacted 1 time — consider starting a new session');
  });
});
