/**
 * Live regression drive for docs/ticket-freshness-leaf-false-stale.md.
 *
 * The prompt-cache freshness leaf must stay warm for the WHOLE active window and
 * only start its 5-min countdown from the true end. Its `live` prop is
 * `liveSessionIds.has(id)`, derived from `sdkSessionManager.getActiveSessionIds()`
 * (isProcessing) and pushed to the sidebar on every session:health event — so this
 * drives one real, multi-tool turn and asserts, end-to-end:
 *
 *   - while the turn is in flight the session's sidebar leaf shows the LIVE title
 *     ("Session active — prompt cache warm") — pinned green, not counting down;
 *   - immediately after completion the leaf switches to the idle countdown title
 *     and reads NEARLY the full window (~4–5m left), proving `lastActiveAt` was
 *     anchored at the real end (usage/completion stamp), not left false-stale.
 *
 * The deterministic appearance logic (live-pin, interpolation, TTL expiry) is
 * covered separately and cheaply by tests/unit/freshness.test.ts — this spec only
 * proves the live wiring (isProcessing → liveSessionIds → leaf `live`) that a unit
 * test can't.
 *
 * COST/TIME: runs a real multi-tool Claude turn under <repo>/../fury-e2e-freshness
 * (wiped each run). Budget a few minutes. Lives in tests/live-sessions (like the
 * other costly drives), not the default unit suite.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { sleep, reapPidFiles, resetProjectDir, driveTurn, cleanupSession } from './drive-helpers';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-freshness');

/** Parse "…~Xm Ys of warmth left" → remaining seconds, or null if not the idle title. */
function remainingSecondsFromTitle(title: string | null): number | null {
  if (!title) return null;
  const m = /~(\d+)m (\d+)s of warmth left/.exec(title);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

let createdSessionId: string | null = null;

test.afterAll(async () => {
  await cleanupSession(createdSessionId, PROJECT);
});

test('freshness leaf stays live-warm across the turn, then counts down from the true end', async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-freshness'));
  await resetProjectDir(PROJECT);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  // A multi-tool turn long enough to cross several live-session scan/health emits,
  // so the leaf is observably pinned live for a sustained window.
  const prompt =
    'Create three files a.js, b.js, c.js. Work ONE at a time and strictly in order: ' +
    'for each, first write the file with exactly `module.exports = 1;`, then run ' +
    "`node -e \"console.log(require('./FILE'))\"` to verify before moving on. " +
    'Do not create any other files. No explanation.';
  const res = await driveTurn(sessionId, PROJECT, prompt);
  expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

  // Open the session so its SSE (session:health/usage) drives the sidebar leaf.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Create three files' }).first();
  await expect(row, 'session appears in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();
  // The composer's action button is testid'd conditionally — 'stop-button' while
  // the turn is processing (which it is right now), 'send-button' at rest
  // (RichTextEditor.tsx). Accept either so this confirms the session view opened
  // without assuming the turn's phase.
  await expect(
    page.getByTestId('send-button').or(page.getByTestId('stop-button')),
    'viewing the session shows the composer',
  ).toBeVisible({ timeout: 20_000 });

  const dots = page.getByTestId('processing-dots');
  await expect(dots, 'dots appear during the turn').toBeVisible({ timeout: 30_000 });

  // The leaf lives in the session's sidebar row; both live and idle titles contain
  // "cache warm", so this locator matches in either state.
  const leaf = row.locator('span[title*="cache warm"]');

  // ---- While in flight: the leaf is pinned LIVE and never goes cold ----
  // Poll ~1s for the active window. Two signals:
  //   - liveTitleSeen: how often the leaf is in its pinned "Session active" state
  //     (proves the isProcessing → liveSessionIds → leaf `live` wiring);
  //   - coldWhileProcessing: the leaf is HIDDEN or reads < 60s of warmth while the
  //     turn is still running — the false-stale bug. (A brief idle-but-still-fresh
  //     title in the ~1s before liveSessionIds first propagates is benign: it reads
  //     the full ~5m from entry.timestamp, so it is NOT counted as cold.)
  let liveTitleSeen = 0;
  let coldWhileProcessing = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    const dotsVisible = await dots.isVisible().catch(() => false);
    if (!dotsVisible) break;
    const visible = await leaf.isVisible().catch(() => false);
    const title = visible ? await leaf.getAttribute('title').catch(() => null) : null;
    if (title === 'Session active — prompt cache warm') {
      liveTitleSeen++;
    } else {
      const remaining = remainingSecondsFromTitle(title);
      // Hidden (stale/gone) or nearly cold while still processing = the bug.
      if (!visible || (remaining != null && remaining < 60)) coldWhileProcessing++;
    }
    await sleep(1000);
  }
  console.log(`[E2E] liveTitleSeen=${liveTitleSeen} coldWhileProcessing=${coldWhileProcessing}`);
  expect(liveTitleSeen, 'the leaf shows the live "warm" title while the turn is in flight').toBeGreaterThanOrEqual(3);
  expect(coldWhileProcessing, 'the leaf never goes stale/cold while the session is still processing').toBe(0);

  // ---- On completion: leaf flips to the idle countdown, anchored at the true end ----
  await expect(page.getByTestId('send-button'), 'composer returns when the turn ends').toBeVisible({ timeout: 30_000 });
  await expect(dots, 'dots are gone after completion').toBeHidden();

  // Give the session:health idle event a beat to remove the session from
  // liveSessionIds and re-render the leaf in its idle state.
  await expect
    .poll(async () => (await leaf.getAttribute('title').catch(() => null)) ?? '', { timeout: 15_000 })
    .not.toBe('Session active — prompt cache warm');

  const idleTitle = await leaf.getAttribute('title');
  const remainingS = remainingSecondsFromTitle(idleTitle);
  console.log(`[E2E] idleTitle="${idleTitle}" remainingS=${remainingS}`);
  expect(remainingS, 'the leaf shows the idle countdown title after completion').not.toBeNull();
  // Freshly anchored: lastActiveAt ≈ completion, so warmth is near the full 5-min
  // window. A false-stale anchor (the bug) would read much lower or be gone.
  expect(remainingS!, 'countdown starts from the true end (>=4m of ~5m left)').toBeGreaterThanOrEqual(4 * 60);

  // Sanity: the turn actually did the work.
  expect(existsSync(join(PROJECT, 'c.js')), 'the turn created c.js').toBe(true);
});
