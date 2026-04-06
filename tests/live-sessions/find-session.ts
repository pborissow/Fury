import type { Page, Locator } from '@playwright/test';

interface FindSessionOpts {
  /** Session ID (exact match via API, then click in sidebar) */
  sessionId?: string;
  /** Label text (e.g. "Video UI") — matches against the label or display text */
  label?: string;
  /** Timestamp string as shown in the sidebar, e.g. "Apr 5 06:58 AM" */
  timestamp?: string;
  /** Substring of the first message / display text */
  displayText?: string;
}

/**
 * Locate a session card in the sidebar using multiple fallback strategies:
 *   1. label / displayText  — text match against the session body
 *   2. timestamp            — text match against the HistoryTimestamp span
 *   3. sessionId            — resolve to display text via /api/history, then text match
 *
 * The helper scrolls the sidebar if needed to find sessions below the fold.
 * Returns the Locator for the matched session card, or null if not found.
 */
export async function findSessionInSidebar(
  page: Page,
  opts: FindSessionOpts,
): Promise<Locator | null> {
  const sidebar = page.locator('.overflow-y-auto').first();
  const sessionCards = sidebar.locator('.rounded.border');

  // Wait for at least one card to appear
  try {
    await sessionCards.first().waitFor({ timeout: 10_000 });
  } catch {
    return null;
  }

  // Build a list of text matchers to try, in priority order
  const matchers: { description: string; match: (card: Locator) => Promise<boolean> }[] = [];

  if (opts.label) {
    const label = opts.label;
    matchers.push({
      description: `label "${label}"`,
      match: async (card) => {
        const text = await card.locator('.text-sm.text-foreground').textContent().catch(() => '');
        return !!text && text.includes(label);
      },
    });
  }

  if (opts.displayText) {
    const snippet = opts.displayText;
    matchers.push({
      description: `displayText "${snippet}"`,
      match: async (card) => {
        const text = await card.locator('.text-sm.text-foreground').textContent().catch(() => '');
        return !!text && text.includes(snippet);
      },
    });
  }

  if (opts.timestamp) {
    const ts = opts.timestamp;
    matchers.push({
      description: `timestamp "${ts}"`,
      match: async (card) => {
        const text = await card.locator('.text-xs.text-muted-foreground').first().textContent().catch(() => '');
        return !!text && text.includes(ts);
      },
    });
  }

  if (opts.sessionId) {
    // Resolve sessionId to display text / label via the history API
    const res = await page.request.get('/api/history');
    if (res.ok()) {
      const { entries } = await res.json();
      const entry = entries?.find((e: any) => e.sessionId === opts.sessionId);
      if (entry) {
        const searchText = entry.metadata?.label || entry.display?.substring(0, 30);
        if (searchText) {
          matchers.push({
            description: `sessionId → "${searchText}"`,
            match: async (card) => {
              const text = await card.locator('.text-sm.text-foreground').textContent().catch(() => '');
              return !!text && text.includes(searchText);
            },
          });
        }
      }
    }
  }

  if (matchers.length === 0) return null;

  // Try each matcher, scrolling the sidebar to find cards below the fold
  for (const matcher of matchers) {
    // Reset scroll
    await sidebar.evaluate(el => el.scrollTop = 0);

    for (let scroll = 0; scroll < 15; scroll++) {
      const count = await sessionCards.count();
      for (let i = 0; i < count; i++) {
        const card = sessionCards.nth(i);
        if (await card.isVisible() && await matcher.match(card)) {
          return card;
        }
      }
      // Scroll down to reveal more cards
      const prevScroll = await sidebar.evaluate(el => el.scrollTop);
      await sidebar.evaluate(el => el.scrollBy(0, 200));
      await page.waitForTimeout(150);
      const newScroll = await sidebar.evaluate(el => el.scrollTop);
      if (newScroll === prevScroll) break; // reached bottom
    }
  }

  return null;
}

/**
 * Find a stuck session by querying the health API for recent history entries.
 * Returns the session ID and health data, or null if none are stuck.
 */
export async function findStuckSession(
  page: Page,
): Promise<{ sessionId: string; project: string; display: string; label?: string; health: any } | null> {
  const historyRes = await page.request.get('/api/history');
  if (!historyRes.ok()) return null;
  const { entries } = await historyRes.json();

  for (const entry of (entries?.slice(0, 15) || [])) {
    if (!entry.sessionId) continue;
    const healthRes = await page.request.get(
      `/api/health?sessionId=${encodeURIComponent(entry.sessionId)}`
    );
    if (!healthRes.ok()) continue;
    const health = await healthRes.json();
    if (health.isProcessing && health.isStuck) {
      return {
        sessionId: entry.sessionId,
        project: entry.project,
        display: entry.display,
        label: entry.metadata?.label,
        health,
      };
    }
  }
  return null;
}
