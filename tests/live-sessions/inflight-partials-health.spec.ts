/**
 * Live regression drive for docs/ticket-inflight-partials-health-startedat.md
 * (Part B) and its parent (docs/ticket-inflight-partials-render-as-bubbles.md).
 *
 * Drives ONE long, multi-tool turn that crosses several 15s health-poll ticks and
 * asserts the in-flight partial-stripping invariant end-to-end:
 *
 *   - while the turn is processing, the bouncing dots stay visible and the center
 *     panel renders ZERO Claude bubbles (the JSONL's in-flight partials must NOT
 *     surface as intermediary bubbles above the dots);
 *   - on completion the turn collapses cleanly — dots gone, exactly the final
 *     Claude bubble present.
 *
 * And Part A specifically: the server's `sdk.health processing` log lines for this
 * session now carry a numeric `startedAt` (the strip anchor the latch-break reads).
 * If the transient-false latch-break fires, its `chat.health` re-strip line must
 * log a real startedAt, never null — the exact acceptance signal from the ticket.
 *
 * COST/TIME: runs a real multi-tool Claude turn under <repo>/../fury-e2e-inflight
 * (wiped each run). Budget a few minutes. Lives in tests/live-sessions (like the
 * other costly drives), not the default unit suite.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn, cleanupSession,
} from './drive-helpers';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-inflight');

let createdSessionId: string | null = null;

test.afterAll(async () => {
  await cleanupSession(createdSessionId, PROJECT);
});

test('in-flight partials stay stripped across health ticks; health carries startedAt', async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-inflight'));
  await resetProjectDir(PROJECT);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  // A long, multi-tool turn: five write+verify steps, strictly one at a time, so
  // it crosses several 15s health-poll ticks and produces many partial assistant
  // messages in the JSONL — exactly what must NOT render as bubbles.
  const prompt =
    'Create five files step1.js, step2.js, step3.js, step4.js, step5.js. Work ONE at a ' +
    'time and strictly in order: for each stepN.js, first write the file with exactly ' +
    '`module.exports = () => N;`, then run `node -e "console.log(require(\'./stepN.js\')())"` ' +
    'to verify it prints N before moving to the next. Do not create any other files. No explanation.';
  const res = await driveTurn(sessionId, PROJECT, prompt);
  expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

  // Open the session in the UI so the transcript + dots render.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Create five files' }).first();
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

  // Poll ~1s for the whole turn. The invariant: while dots are up, the center
  // Claude-bubble count is 0. Track it ONLY while processing so the final
  // collapsed bubble doesn't count against us.
  let maxBubblesWhileProcessing = 0;
  let dotsTicks = 0;
  let ticks = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    const dotsVisible = await dots.isVisible().catch(() => false);
    const bubbles = await page.getByTestId('claude-turn').count();
    ticks++;
    if (dotsVisible) {
      dotsTicks++;
      maxBubblesWhileProcessing = Math.max(maxBubblesWhileProcessing, bubbles);
    }
    // Turn is over once dots are gone and the final bubble has rendered.
    if (!dotsVisible && bubbles >= 1) break;
    await sleep(1000);
  }
  const durationS = Math.round((Date.now() - t0) / 1000);
  console.log(`[E2E] ticks=${ticks} dotsTicks=${dotsTicks} maxBubblesWhileProcessing=${maxBubblesWhileProcessing} durationS=${durationS}`);

  // ---- Core invariant: partials never rendered as bubbles ----
  expect(maxBubblesWhileProcessing, 'no Claude bubble may render while the turn is in-flight').toBe(0);
  // The turn was genuinely long — dots persisted across multiple 1s polls,
  // crossing at least one 15s health tick (usually two for this prompt).
  expect(dotsTicks, 'dots persisted across many polls (long, multi-tool turn)').toBeGreaterThanOrEqual(15);

  // ---- Clean collapse on completion ----
  await expect(page.getByTestId('send-button'), 'composer returns when the turn ends').toBeVisible({ timeout: 30_000 });
  await expect(dots, 'dots are gone after completion').toBeHidden();
  expect(await page.getByTestId('claude-turn').count(), 'the finished turn collapses to its Claude bubble').toBeGreaterThanOrEqual(1);

  // ---- Part A: server health lines carry a numeric startedAt ----
  const logs = furyLogLinesFor(sessionId);
  const healthProcessing = logs.filter((e) => e.scope === 'sdk.health' && e.msg === 'processing');
  console.log(`[E2E] sdk.health processing lines=${healthProcessing.length}`);
  expect(healthProcessing.length, 'the turn logged at least one processing health line').toBeGreaterThan(0);
  expect(
    healthProcessing.some((e) => typeof e?.data?.startedAt === 'number'),
    'a processing health line carries a numeric startedAt (the strip anchor)',
  ).toBe(true);

  // If the transient-false latch-break fired, its re-strip must anchor on a REAL
  // startedAt (was null every time before Part A).
  const latch = logs.filter((e) => e.scope === 'chat.health' && /latch-break/.test(e.msg || ''));
  console.log(`[E2E] chat.health latch-break lines=${latch.length}`);
  for (const l of latch) {
    expect(l?.data?.startedAt, 'latch-break re-strip must log a real startedAt, not null').not.toBeNull();
  }

  // Sanity: the turn actually did the multi-tool work.
  expect(existsSync(join(PROJECT, 'step5.js')), 'the long turn created step5.js').toBe(true);
});
