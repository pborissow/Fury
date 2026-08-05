/**
 * Live drive to REPRODUCE + verify the two badge issues around background subagents
 * (docs/ticket-live-badge-dark-during-background-subagent.md):
 *
 *   A. During the wait while a dispatched background subagent works, the session
 *      must stay LIVE (badge) and show dots — the v24 fix.
 *   B. After ALL work settles (main turn idle, no background work), the session must
 *      drop to NOT-live — the stale-LIVE-while-idle bug from the screenshot.
 *
 * The trick: a coercive CLAUDE.md that forces the orchestrator to DISPATCH every
 * unit of work to a subagent and NOT block, so its main turn ends while the
 * subagents keep running — the exact shape that goes dark without the fix. This
 * reliably backgrounds real CLI Task subagents, which DO emit the SDK's
 * `background_tasks_changed` level signal (a harness `run_in_background` bash does
 * NOT — verified live; that was the red herring during diagnosis).
 *
 * Verified across the whole background window (see the assertions):
 *   - `background_tasks_changed` fires (subagents genuinely backgrounded);
 *   - while the main turn is idle and subagents work, the session stays LIVE and
 *     shows dots on EVERY poll — darkGap == 0 (Issue A / v24 fix);
 *   - once all tasks drain, the session drops to NOT-live (Issue B / no stale-LIVE).
 *
 * COST/TIME: runs a real multi-subagent orchestration under <repo>/../fury-e2e-subagents.
 * Budget up to ~10 min. Lives in tests/live-sessions (costly), not the unit suite.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn, cleanupSession, BASE_URL } from './drive-helpers';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-subagents');

const CLAUDE_MD = `# Project: Rewrite Fury in Python (fury-py)

You are the ORCHESTRATOR. You coordinate a rewrite by DELEGATING every unit of
implementation work to a separate subagent. You must NOT implement modules yourself.

## Hard rules — follow EXACTLY
1. For EACH module listed below, launch a SEPARATE subagent (the Task tool) to build it.
2. Launch the subagents to run CONCURRENTLY / in the BACKGROUND. Do NOT wait for one
   subagent to finish before launching the next, and do NOT wait for their results
   before ending your turn. Dispatch them all, then STOP.
3. Each subagent's instructions must be exactly: "Create the named Python file with a
   module docstring and two function stubs (\`def load(): pass\` etc.). Then run the
   shell command \`sleep 25\` to simulate compile+test. Then append the line '# done'
   to the file. Report one line."
4. After dispatching ALL module subagents, END YOUR TURN IMMEDIATELY with a short
   bullet list of which modules you launched. Do not wait. Do not summarize results.

## Modules (one subagent each)
- fury_py/transcripts.py
- fury_py/sessions.py
- fury_py/live.py
- fury_py/health.py
- fury_py/events.py
- fury_py/api.py
`;

const KICKOFF =
  'Read CLAUDE.md and execute the rewrite EXACTLY as specified. Launch one background ' +
  'subagent per module, do not wait for any of them, and end your turn immediately with ' +
  'the list of modules you launched.';

let createdSessionId: string | null = null;

test.afterAll(async () => {
  await cleanupSession(createdSessionId, PROJECT);
});

const health = async (sessionId: string) => {
  try { return await (await fetch(`${BASE_URL}/api/health?sessionId=${sessionId}`)).json(); }
  catch { return {}; }
};
const liveSet = async (): Promise<string[]> => {
  try { return (await (await fetch(`${BASE_URL}/api/live-sessions`)).json()).liveSessionIds || []; }
  catch { return []; }
};

test('background-subagent orchestration: capture liveness + dots timeline', async ({ page }) => {
  test.setTimeout(12 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-subagents'));
  await resetProjectDir(PROJECT);
  writeFileSync(join(PROJECT, 'CLAUDE.md'), CLAUDE_MD);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  const res = await driveTurn(sessionId, PROJECT, KICKOFF);
  expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

  // Open the session in the UI so we can also watch the dots.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Read CLAUDE.md' }).first();
  await expect(row, 'session appears in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    page.getByTestId('send-button').or(page.getByTestId('stop-button')),
    'session view opened',
  ).toBeVisible({ timeout: 20_000 });

  const dots = page.getByTestId('processing-dots');

  // Poll a compact timeline. Record only TRANSITIONS to keep the log readable, but
  // tally the invariant-bearing samples across EVERY poll.
  type Sample = { t: number; live: boolean; dots: boolean; proc: boolean; bg: boolean };
  const transitions: Sample[] = [];
  let last = '';
  // The window this whole ticket is about: main turn idle, background work running.
  let bgWaitSamples = 0;      // proc=false && bg=true
  let bgWaitLive = 0;         // …and live      (fix working — badge stays on)
  let bgWaitDots = 0;         // …and dots      (fix working — dots stay on)
  let darkGap = 0;            // …and NOT live  (the bug: live badge went dark)
  let settledNotLive = false; // end state: fully idle AND not live (no stale-LIVE)
  const t0 = Date.now();
  const DEADLINE = 10 * 60 * 1000;
  const IDLE_SETTLE_MS = 45_000; // stop once fully idle+not-live for this long
  let idleSince = 0;

  while (Date.now() - t0 < DEADLINE) {
    const [ids, h] = await Promise.all([liveSet(), health(sessionId)]);
    const live = ids.includes(sessionId);
    const dotsVisible = await dots.isVisible().catch(() => false);
    const s: Sample = { t: Math.round((Date.now() - t0) / 1000), live, dots: dotsVisible, proc: !!h.isProcessing, bg: !!h.backgroundActive };
    const key = `${s.live}|${s.dots}|${s.proc}|${s.bg}`;
    if (key !== last) { transitions.push(s); last = key; console.log(`[E2E] t=${s.t}s live=${s.live} dots=${s.dots} proc=${s.proc} bg=${s.bg}`); }

    if (!s.proc && s.bg) {
      bgWaitSamples++;
      if (s.live) bgWaitLive++; else darkGap++;
      if (s.dots) bgWaitDots++;
    }

    // Settled = not processing, not live, no bg, no dots — hold it for a while so a
    // brief between-subagent lull isn't mistaken for the end.
    if (!s.proc && !s.live && !s.bg && !s.dots) {
      settledNotLive = true;
      if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_SETTLE_MS) break;
    } else {
      idleSince = 0;
    }
    await sleep(2000);
  }

  // ---- Signal report from the logs ----
  const logs = furyLogLinesFor(sessionId);
  const evline = (e: any) => `${e.scope}/${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`;
  const interesting = logs.filter((e) => ['sdk.turn', 'sdk.health', 'sdk.bg', 'sdk.sys'].includes(e.scope));
  console.log(`\n[E2E] ===== signal timeline (${interesting.length} lines) =====`);
  for (const e of interesting) console.log('   ' + evline(e));

  const sysSubtypes = new Map<string, number>();
  for (const e of logs.filter((e) => e.scope === 'sdk.sys')) sysSubtypes.set(e.msg, (sysSubtypes.get(e.msg) || 0) + 1);
  const bgLines = logs.filter((e) => e.scope === 'sdk.bg').length;
  const turnStarts = logs.filter((e) => e.scope === 'sdk.turn' && e.msg === 'start').length;
  const files = existsSync(join(PROJECT, 'fury_py')) ? readdirSync(join(PROJECT, 'fury_py')) : [];

  console.log('\n[E2E] ===== SUMMARY =====');
  console.log(`   turn starts:            ${turnStarts}`);
  console.log(`   background_tasks_changed (sdk.bg) lines: ${bgLines}`);
  console.log(`   task_* system subtypes: ${JSON.stringify(Object.fromEntries(sysSubtypes))}`);
  console.log(`   modules created:        ${JSON.stringify(files)}`);
  console.log(`   bg-wait samples (proc=false,bg=true): ${bgWaitSamples}  live=${bgWaitLive} dots=${bgWaitDots} darkGap=${darkGap}`);
  console.log(`   settled not-live at end: ${settledNotLive}`);

  // ---- Regression assertions ----
  // 1. Real subagents were actually backgrounded (the scenario reproduced).
  expect(bgLines, 'background_tasks_changed fired — subagents ran in the background').toBeGreaterThan(0);
  // 2. There WAS a background-wait window (main turn idle while subagents worked).
  expect(bgWaitSamples, 'observed the main-turn-idle-while-background-working window').toBeGreaterThan(0);
  // 3. Issue A (the v24 fix): during that window the session stayed LIVE and showed
  //    dots on every sample — the badge/dots never went dark while work continued.
  expect(darkGap, 'badge must NEVER go dark while background work is running').toBe(0);
  expect(bgWaitLive, 'session was live throughout the background wait').toBe(bgWaitSamples);
  expect(bgWaitDots, 'dots were shown throughout the background wait').toBe(bgWaitSamples);
  // 4. Issue B (no stale-LIVE): once everything drained, the session dropped to
  //    not-live (backgroundActive:false, count 0) — not pinned green while idle.
  expect(settledNotLive, 'session settled to NOT-live once all work finished').toBe(true);
  expect(await liveSet(), 'final live set excludes the now-idle session').not.toContain(sessionId);
});
