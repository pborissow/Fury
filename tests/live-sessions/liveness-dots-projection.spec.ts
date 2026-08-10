/**
 * Step 2b live check: the projection-driven dots.
 * (docs/design-liveness-single-source-of-truth.md §3.)
 *
 * With the `fury.livenessDots` opt-in on, the focused session's bouncing dots render
 * off the single liveness projection (`live.phase !== 'idle'`) instead of the legacy
 * `transcriptLoading || backgroundWorking` OR-of-proxies. This drives ONE trivial turn
 * (a one-word reply, ~seconds — far cheaper than the Gypsy planning drive) and asserts
 * the dots track `/api/health.liveness.phase`: lit while `main-turn`, gone once `idle`,
 * with no mid-turn dark tick and no lingering-lit-after-idle tick.
 *
 * Runs headless so it never steals focus from a live session. Needs the dev server up
 * (webServer reuse) on the V36+ build (heartbeat + projection).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { sleep, reapPidFiles, resetProjectDir, driveTurn, cleanupSession, BASE_URL } from './drive-helpers';

test.use({ headless: true });

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-liveness-dots');
const KICKOFF = 'Reply with exactly the word: hello. Output nothing else — no tools, no preamble.';

let sid: string | null = null;
test.afterAll(async () => { await cleanupSession(sid, PROJECT); });

const health = async (sessionId: string): Promise<any> => {
  try { return await (await fetch(`${BASE_URL}/api/health?sessionId=${sessionId}`)).json(); }
  catch { return {}; }
};

test('projection-driven dots track liveness.phase across a turn', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);

  sid = randomUUID();
  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-liveness-dots'));
  await resetProjectDir(PROJECT);
  mkdirSync(PROJECT, { recursive: true });

  // Turn the opt-in ON before ChatTab mounts (it reads localStorage once at mount).
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('fury.livenessDots', '1'));

  const res = await driveTurn(sid, PROJECT, KICKOFF);
  expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Reply with exactly the word' }).first();
  await expect(row, 'session appears in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    page.getByTestId('send-button').or(page.getByTestId('stop-button')),
    'session view opened',
  ).toBeVisible({ timeout: 20_000 });

  const dots = page.getByTestId('processing-dots');
  const bubbles = page.getByTestId('claude-turn');

  // Sample the projection phase (PULL) alongside the DOM dots + committed-bubble count.
  type S = { t: number; phase?: string; dots: boolean; bubbles: number };
  const samples: S[] = [];
  const t0 = Date.now();
  let sawMain = false, settled = 0;
  while (Date.now() - t0 < 120_000) {
    const [h, dotsVisible, bubbleCount] = await Promise.all([
      health(sid!),
      dots.isVisible().catch(() => false),
      bubbles.count().catch(() => 0),
    ]);
    const phase: string | undefined = h?.liveness?.phase;
    if (phase === 'main-turn') sawMain = true;
    samples.push({ t: Math.round((Date.now() - t0) / 1000), phase, dots: dotsVisible, bubbles: bubbleCount });
    // Stop once the projection has settled idle with dots off for a short run.
    if (sawMain && phase === 'idle' && !dotsVisible) { if (++settled > 4) break; } else settled = 0;
    await sleep(700);
  }

  console.log('[E2E] phase/dots/bubbles timeline:');
  let last = '';
  for (const s of samples) { const k = `${s.phase}|${s.dots}|${s.bubbles}`; if (k !== last) { last = k; console.log(`  t=${s.t}s phase=${s.phase} dots=${s.dots} bubbles=${s.bubbles}`); } }

  // Preconditions: the turn actually ran and settled.
  expect(sawMain, 'the projection reported a main-turn phase during the turn').toBe(true);
  const settledIdle = samples.slice(-1)[0];
  expect(settledIdle?.phase, 'the projection settled to idle').toBe('idle');

  // Invariant 1: dots were lit while the projection said main-turn (dots ON via phase).
  const litDuringMain = samples.some((s) => s.phase === 'main-turn' && s.dots);
  expect(litDuringMain, 'dots were visible while phase === main-turn').toBe(true);

  // Invariant 2: no mid-turn dark tick — a non-idle phase must never show dots-off
  // (allow the very first tick before the DOM subscription settles).
  const firstMain = samples.findIndex((s) => s.phase === 'main-turn');
  const darkMidTurn = samples.filter((s, i) => i > firstMain && s.phase && s.phase !== 'idle' && !s.dots);
  expect(darkMidTurn.length, `dots went dark while phase was non-idle (at ${JSON.stringify(darkMidTurn.map((s) => s.t))}s)`).toBe(0);

  // Invariant 3: once settled idle, the dots are gone (no lingering-lit).
  expect(settledIdle?.dots, 'dots were hidden once phase settled idle').toBe(false);

  // Invariant 4 (scenario 1, step 3): while the main turn streams, NO committed
  // assistant bubble is shown — the render-time strip on `live.startedAt` slices this
  // turn's in-flight partials, so nothing leaks above the dots.
  const bubbleDuringMain = samples.filter((s) => s.phase === 'main-turn' && s.bubbles > 0);
  expect(
    bubbleDuringMain.length,
    `scenario 1: a claude-turn bubble was visible while phase === main-turn (at ${JSON.stringify(bubbleDuringMain.map((s) => s.t))}s) — a partial leaked past the projection strip`,
  ).toBe(0);

  // Invariant 5: the render-strip / teardown-gating did NOT eat the final answer — the
  // completed turn's bubble is present and carries the reply once settled idle.
  await expect(bubbles.last(), 'the final answer renders after completion').toContainText(/hello/i, { timeout: 15_000 });
});
