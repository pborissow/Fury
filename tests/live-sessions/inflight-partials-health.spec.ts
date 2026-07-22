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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findSessionJsonlDir } from '../../lib/sessionPaths';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-inflight');
const BASE_URL = 'http://localhost:3879';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jsonlPath = (sessionId: string): string | null => {
  const loc = findSessionJsonlDir(sessionId, PROJECT);
  return loc ? join(loc.dir, `${sessionId}.jsonl`) : null;
};

function reapPidFiles(match: (entry: any) => boolean): void {
  const dir = join(homedir(), '.claude', 'sessions');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = join(dir, f);
    try {
      const e = JSON.parse(readFileSync(full, 'utf8'));
      if (match(e) && typeof e.pid === 'number') {
        try { process.kill(e.pid, 'SIGKILL'); } catch { /* dead */ }
        try { rmSync(full); } catch { /* leave stale */ }
      }
    } catch { /* skip */ }
  }
}

/** All fury-log entries for a session, across daily files. */
function furyLogLinesFor(sessionId: string): any[] {
  const dir = join(homedir(), '.claude', 'fury-logs');
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.sessionId === sessionId) out.push(e); } catch { /* partial */ }
    }
  }
  return out;
}

let createdSessionId: string | null = null;

test.afterAll(async () => {
  if (!createdSessionId) return;
  try {
    await fetch(
      `${BASE_URL}/api/session?sessionId=${encodeURIComponent(createdSessionId)}&project=${encodeURIComponent(PROJECT)}`,
      { method: 'DELETE' },
    );
  } catch { /* server down — disk fallback below */ }
  try { const p = jsonlPath(createdSessionId); if (p) rmSync(p); } catch { /* best effort */ }
  reapPidFiles((e) => e.sessionId === createdSessionId);
  try {
    const hist = join(homedir(), '.claude', 'history.jsonl');
    if (existsSync(hist)) {
      const kept = readFileSync(hist, 'utf8').split('\n').filter((l) => !l.includes(createdSessionId!));
      writeFileSync(hist, kept.join('\n'));
    }
  } catch { /* best effort */ }
});

test('in-flight partials stay stripped across health ticks; health carries startedAt', async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-inflight'));
  for (let i = 0; i < 6; i++) {
    try { rmSync(PROJECT, { recursive: true, force: true }); break; } catch { await sleep(500); }
  }
  mkdirSync(PROJECT, { recursive: true });

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
  const res = await page.request.post('/api/claude-sdk', { data: { prompt, sessionId, projectPath: PROJECT } });
  expect(res.ok(), '/api/claude-sdk accepts the turn').toBe(true);

  // Open the session in the UI so the transcript + dots render.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Create five files' }).first();
  await expect(row, 'session appears in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('send-button'), 'viewing the session shows the composer').toBeVisible({ timeout: 20_000 });

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
