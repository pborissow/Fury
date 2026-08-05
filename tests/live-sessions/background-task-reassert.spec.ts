/**
 * Live regression drive for docs/ticket-background-task-notification-turns-render-dark.md.
 *
 * The bug: when the SDK runs a turn the user never submitted — a background task
 * (Monitor/backgrounded Bash) posting a <task-notification> back into the
 * conversation — only the submit path used to turn the dots on, so after the first
 * turn's `result` the session flipped idle and streamed the notification turn
 * "dark", leaking its partial assistant messages as intermediary bubbles.
 *
 * This drives a turn that launches a REAL background task which outlives the turn,
 * so its completion posts a <task-notification> and drives a second, un-submitted
 * turn. It then asserts the ticket's stated acceptance proof, from
 * ~/.claude/fury-logs/ (docs/logging-and-telemetry.md):
 *
 *   after a mid-window `sdk.turn:done`, a `sdk.turn:reassert` + a SECOND
 *   `sdk.health:processing` re-appear with a FRESH startedAt (the strip anchor),
 *   then that background turn ends with its own `done`/`idle`.
 *
 * Pre-fix there was exactly ONE `processing` and no `reassert` — the session went
 * idle at the first `done` and never came back. The deterministic state-machine of
 * the re-assert is unit-tested in tests/unit/sdk-background-turn-reassert.test.ts;
 * this proves it fires end-to-end against a real notification-driven turn.
 *
 * COST/TIME: runs a real (short) Claude turn + a background task under
 * <repo>/../fury-e2e-bgtask (wiped each run). Budget ~2 min. Lives in
 * tests/live-sessions (the costly-drive suite), not the default unit run.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import {
  sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn, cleanupSession,
} from './drive-helpers';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-bgtask');

let createdSessionId: string | null = null;

test.afterAll(async () => {
  await cleanupSession(createdSessionId, PROJECT);
});

test('a background-task notification turn re-asserts processing (dots stay, not dark)', async () => {
  test.setTimeout(4 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-bgtask'));
  await resetProjectDir(PROJECT);
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  // Launch a background task that OUTLIVES the turn, so its completion arrives as
  // a <task-notification> that drives a second, un-submitted turn.
  const prompt =
    'Use the Bash tool to run this command in the BACKGROUND (run_in_background=true): ' +
    '`sleep 18 && echo FURY_BG_DONE`. Do NOT wait for it or read its output. Immediately ' +
    'after launching it, end your turn right away with a one-line confirmation and no ' +
    'further tool calls. When the background command finishes later, briefly acknowledge ' +
    'that it printed FURY_BG_DONE.';
  const res = await driveTurn(sessionId, PROJECT, prompt);
  expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

  // Poll the fury-log until the background (notification) turn has re-asserted and
  // completed, or time out. The background task sleeps ~18s, so give it room.
  let logs: any[] = [];
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    logs = furyLogLinesFor(sessionId);
    const reasserts = logs.filter((e) => e.scope === 'sdk.turn' && e.msg === 'reassert').length;
    const dones = logs.filter((e) => e.scope === 'sdk.turn' && e.msg === 'done').length;
    if (reasserts >= 1 && dones >= 2) break; // submitted turn + background turn both done
  }

  const turnHealth = logs.filter(
    (e) => e.scope === 'sdk.turn' || e.scope === 'sdk.health',
  );
  console.log('[E2E] turn/health sequence:');
  for (const e of turnHealth) {
    console.log(`   ${e.scope} ${e.msg} startedAt=${e?.data?.startedAt ?? ''}`);
  }

  const processing = turnHealth.filter((e) => e.scope === 'sdk.health' && e.msg === 'processing');
  const reasserts = turnHealth.filter((e) => e.scope === 'sdk.turn' && e.msg === 'reassert');
  const dones = turnHealth.filter((e) => e.scope === 'sdk.turn' && e.msg === 'done');

  // ---- Core acceptance signature (ticket criteria 2 & 4) ----
  // Pre-fix: exactly ONE processing, no reassert. Post-fix: the notification turn
  // re-asserts, so there are >=2 processing lines and >=1 reassert.
  expect(reasserts.length, 'the background notification turn re-asserted processing').toBeGreaterThanOrEqual(1);
  expect(processing.length, 'a SECOND processing health line re-appears for the background turn').toBeGreaterThanOrEqual(2);
  expect(dones.length, 'both the submitted turn and the background turn produced a result').toBeGreaterThanOrEqual(2);

  // The re-asserted processing carries a FRESH startedAt (the strip anchor the
  // client's latch-break re-strips on), distinct from the submitted turn's.
  const startedAts = processing
    .map((e) => e?.data?.startedAt)
    .filter((v) => typeof v === 'number');
  expect(startedAts.length, 'every processing line carries a numeric startedAt anchor').toBe(processing.length);
  expect(new Set(startedAts).size, 'the re-asserted turn uses a fresh startedAt, not the submit turn\'s').toBeGreaterThanOrEqual(2);

  // Ordering: the re-assert happens AFTER a completed turn (mid-window), which is
  // exactly the transition that used to leave the session dark.
  const firstDoneIdx = turnHealth.findIndex((e) => e.scope === 'sdk.turn' && e.msg === 'done');
  const reassertIdx = turnHealth.findIndex((e) => e.scope === 'sdk.turn' && e.msg === 'reassert');
  expect(firstDoneIdx, 'a turn completed before the re-assert').toBeGreaterThanOrEqual(0);
  expect(reassertIdx, 'the re-assert came after the first completed turn').toBeGreaterThan(firstDoneIdx);
  // Note: both turns running is already proven by dones >= 2 above; we deliberately
  // don't assert on a model-written marker file, since whether the model writes one
  // is non-deterministic and not what this spec is testing.
});
