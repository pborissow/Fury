/**
 * Live drive to REPRODUCE the two in-flight rendering defects the user hits on a
 * real work machine during scout-heavy PLANNING sessions (distinct from the two
 * existing drives, which use a background-orchestrator + simple writes):
 *
 *   (1) An intermediary Claude bubble renders ABOVE the bouncing dots — the dots
 *       are correct, the bubble is a leaked in-flight partial that should have
 *       been stripped.  → symptom: `claude-turn` count > 0 WHILE dots are visible.
 *   (2) An intermediary Claude message shows with NO bouncing dots even though the
 *       turn is still working.  → symptom: `isProcessing` (or backgroundActive)
 *       true while `processing-dots` is hidden.
 *
 * Hypothesis being tested (grounded in the code map + docs/ticket-inflight-*.md and
 * docs/ticket-live-badge-dark-during-background-subagent.md):
 *   - PLANNING fans out PARALLEL FOREGROUND `scout` subagents. These run inside the
 *     awaiting main turn, so they do NOT emit `background_tasks_changed` — meaning
 *     `backgroundWorking` can't keep the dots lit; only `transcriptLoading` can.
 *   - The `case 'result'` handler in sdkSessionManager dropped its sidechain guard
 *     (v18 → removed as "dead code"). If a scout completion surfaces a top-level
 *     `result`, `emitHealth(s,false)` fires MID-turn → a transient isProcessing:false
 *     → dots torn down (scenario 2) and the health-idle refetch commits the prior
 *     main-thread assistant partial un-stripped → it leaks as a bubble once
 *     reassertProcessing relights the dots (scenario 1).
 *
 * This spec is written as a REPRODUCTION: the invariant assertions are expected to
 * FAIL on current code when the bug fires, pinning the exact tick + correlating the
 * fury-log flip. It doubles as the regression guard once the fix lands.
 *
 * The target is a REAL Java codebase (Gypsy) so the scouts have genuine, multi-
 * minute work to do across three subsystems — the fixture project only holds a
 * coercive CLAUDE.md + the scout/plan-reader agents and points them at Gypsy by
 * absolute path, so the real project stays pristine.
 *
 * COST/TIME: runs a real multi-subagent planning turn. Budget up to ~10 min and a
 * few dollars of tokens. Lives in tests/live-sessions (costly), not the unit suite.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn, cleanupSession, BASE_URL,
} from './drive-helpers';

// Repo-parent scratch dir (same convention as the other drives). The fixture is
// rebuilt from scratch each run; Gypsy (the read target) is never written.
const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-planning');
const GYPSY = 'C:\\Users\\petya\\Documents\\Java\\Web Projects\\Gypsy';

// A planner CLAUDE.md that FORCES parallel foreground scouts and forbids reading
// source into the main thread — the exact shape that fans out sidechains while the
// main turn stays processing. Mirrors docs/workflow-enhancements.zip's agreement.
const CLAUDE_MD = `# Planner — Gypsy → Node/React migration

You are a PLANNER. Your job is to produce a migration plan, NOT to read source
code into this (main) thread. Reading big things here is the main cost lever, so
you DELEGATE all code reading to the \`scout\` subagent.

## Hard rules — follow EXACTLY
1. You may NOT Read/Grep/Glob source files yourself. To understand ANY part of the
   target codebase you MUST launch a \`scout\` subagent and act only on its summary.
2. Launch scouts in PARALLEL: put MULTIPLE Task(scout) tool calls in a SINGLE
   message — one scout per subsystem — and wait for them all. Do this at least
   TWICE (an initial survey, then a deeper pass on the areas the survey flags).
3. The target codebase is the Gypsy Java web app at:
   ${GYPSY}
   Its three subsystems are \`JTS/\`, \`WebApp/\`, and \`kartographia-map/\`.
4. After the scouts report, WRITE the plan to \`docs/PLAN-gypsy-node-react.md\`
   (create the docs/ dir). The plan must cover, per subsystem: what it does, the
   Node/React equivalents, migration order, and risks — with \`file:line\` anchors
   the scouts returned. Keep the main thread lean.

## Scouts (one Task per subsystem, run concurrently)
- scout JTS/            → server/topology/geometry code: entry points, key classes.
- scout WebApp/         → the web layer: endpoints, servlets/JSP, JS front-end.
- scout kartographia-map/→ the mapping library: public API surface, dependencies.
`;

// Read-and-summarize scout (Sonnet), from the zip — minus codemogger so the
// fixture needs no per-project search index; it falls back to Grep/Glob/Read.
const SCOUT_MD = `---
name: scout
description: >-
  Reads code and returns a tight summary with file:line references. Use for ANY
  multi-file exploration or understanding a subsystem — so raw file content never
  enters the main thread's context. Returns findings, not file dumps.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a scout. Explore the codebase and return the smallest answer that lets the
main thread act — never paste files back.

Rules:
- Locate first (Grep/Glob), then read only the specific ranges you need — no
  whole-file dumps into your reply.
- Return a concise synthesis: the answer plus exact \`path:line\` references for
  every relevant location. Quote at most a few key lines.
- You are read-only. Do not edit files.
- State what you did NOT check, so the caller knows the scan's boundaries.
`;

const PLAN_READER_MD = `---
name: plan-reader
description: Turns a docs/PLAN-*.md into an ordered execution checklist with file:line targets.
tools: Read, Grep, Glob
model: sonnet
---
You turn a plan document into an ordered execution checklist for another agent.
Resolve each step to concrete \`path:line\` targets; flag ambiguities; list verify
commands. Read-only.
`;

const KICKOFF =
  'Read CLAUDE.md and produce the Gypsy → Node/React migration plan EXACTLY as it ' +
  'specifies. Start by launching parallel scout subagents (one per subsystem, all ' +
  'in one message), wait for their summaries, do a second deeper parallel scout ' +
  'pass on whatever they flag as complex, then write docs/PLAN-gypsy-node-react.md. ' +
  'Do not read source files into this thread yourself.';

function writeFixture(): void {
  mkdirSync(join(PROJECT, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(PROJECT, 'CLAUDE.md'), CLAUDE_MD);
  writeFileSync(join(PROJECT, '.claude', 'agents', 'scout.md'), SCOUT_MD);
  writeFileSync(join(PROJECT, '.claude', 'agents', 'plan-reader.md'), PLAN_READER_MD);
}

let createdSessionId: string | null = null;

test.afterAll(async () => {
  await cleanupSession(createdSessionId, PROJECT);
});

const health = async (sessionId: string) => {
  try { return await (await fetch(`${BASE_URL}/api/health?sessionId=${sessionId}`)).json(); }
  catch { return {}; }
};

test('scout-planning turn: dots stay lit and no partial leaks as a bubble', async ({ page }) => {
  test.setTimeout(14 * 60 * 1000);

  // Sanity: the read target must exist, or the scouts have nothing to chew on.
  expect(existsSync(GYPSY), `Gypsy codebase present at ${GYPSY}`).toBe(true);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-planning'));
  await resetProjectDir(PROJECT);
  writeFixture();

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  const res = await driveTurn(sessionId, PROJECT, KICKOFF);
  expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

  // Open the session so we can watch the dots + bubbles the user actually sees.
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
  const bubbles = page.getByTestId('claude-turn');
  await expect(dots, 'dots appear once the planning turn starts').toBeVisible({ timeout: 60_000 });

  // ---- Timeline ----
  // Record EVERY ~1s sample, then judge after the fact. Instantaneous checks are
  // unreliable here: scenario 2's mechanism is a TRANSIENT isProcessing:false, so
  // at that tick the SDK reads not-working — a naive `working && !dots` would miss
  // it; and a naive `dots && bubble` false-positives on the 1-tick completion tail.
  // Post-processing (trim the trailing fully-idle run; everything before it is
  // "mid-turn") sidesteps both.
  type Sample = { t: number; dots: boolean; bubbles: number; proc: boolean; bg: boolean };
  const samples: Sample[] = [];
  let last = '';

  let sawWork = false;           // gate: only meaningful once real work started
  let settledTicks = 0;          // consecutive fully-idle ticks → end
  const t0 = Date.now();
  const DEADLINE = 11 * 60 * 1000;

  while (Date.now() - t0 < DEADLINE) {
    const [h, dotsVisible, bubbleCount] = await Promise.all([
      health(sessionId),
      dots.isVisible().catch(() => false),
      bubbles.count().catch(() => 0),
    ]);
    const proc = !!h.isProcessing;
    const bg = !!h.backgroundActive;
    const working = proc || bg;
    if (working) sawWork = true;

    const s: Sample = { t: Math.round((Date.now() - t0) / 1000), dots: dotsVisible, bubbles: bubbleCount, proc, bg };
    samples.push(s);
    const key = `${s.dots}|${s.bubbles > 0}|${s.proc}|${s.bg}`;
    if (key !== last) {
      last = key;
      console.log(`[E2E] t=${s.t}s dots=${s.dots} bubbles=${s.bubbles} proc=${s.proc} bg=${s.bg}`);
    }

    // End once fully idle (no work, no dots) for a sustained stretch, so a brief
    // between-scout lull isn't mistaken for the end.
    if (sawWork && !working && !dotsVisible) {
      if (++settledTicks > 20) break; // ~20s idle
    } else {
      settledTicks = 0;
    }
    await sleep(1000);
  }

  // ---- Post-process: trim the trailing fully-idle run; [0, endIdx) is mid-turn ----
  let endIdx = samples.length;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (!s.proc && !s.bg && !s.dots) endIdx = i; else break;
  }
  const dotsFirstIdx = samples.findIndex((s) => s.dots);

  let bubbleAboveDots = 0;        // scenario 1: a bubble visible while dots are up, mid-turn
  let darkMidTurn = 0;            // scenario 2: dots dark after they'd appeared, still mid-turn
  let msgWhileDark = 0;          // scenario 2, stronger: a message showing during the dark gap
  const firstBubbleAboveDotsAt: number[] = [];
  const firstDarkMidTurnAt: number[] = [];
  for (let i = 0; i < endIdx; i++) {
    const s = samples[i];
    if (s.dots && s.bubbles > 0) {
      bubbleAboveDots++;
      if (firstBubbleAboveDotsAt.length < 3) firstBubbleAboveDotsAt.push(s.t);
    }
    if (dotsFirstIdx >= 0 && i > dotsFirstIdx && !s.dots) {
      darkMidTurn++;
      if (s.bubbles > 0) msgWhileDark++;
      if (firstDarkMidTurnAt.length < 3) firstDarkMidTurnAt.push(s.t);
    }
  }

  // ---- Correlate with the fury-logs (the server-side truth) ----
  const logs = furyLogLinesFor(sessionId);
  const evline = (e: any) => `${e.scope}/${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`;
  const turnStarts = logs.filter((e) => e.scope === 'sdk.turn' && e.msg === 'start').length;
  const turnDones = logs.filter((e) => e.scope === 'sdk.turn' && e.msg === 'done').length;
  const healthProcessing = logs.filter((e) => e.scope === 'sdk.health' && e.msg === 'processing').length;
  const healthIdle = logs.filter((e) => e.scope === 'sdk.health' && e.msg === 'idle').length;
  const bgLines = logs.filter((e) => e.scope === 'sdk.bg').length;
  // Mid-turn idles are the smoking gun for the removed result-guard: an idle
  // emitted while the planning turn is demonstrably still going (more than one
  // processing↔idle cycle for a single user prompt).
  const healthFlips = logs
    .filter((e) => e.scope === 'sdk.health' && (e.msg === 'processing' || e.msg === 'idle'))
    .map((e) => e.msg);
  const planWritten = existsSync(join(PROJECT, 'docs', 'PLAN-gypsy-node-react.md'));

  console.log('\n[E2E] ===== SUMMARY =====');
  console.log(`   samples / mid-turn window:  ${samples.length} total, [0,${endIdx}) mid-turn`);
  console.log(`   turn starts / dones:        ${turnStarts} / ${turnDones}`);
  console.log(`   sdk.health processing/idle: ${healthProcessing} / ${healthIdle}`);
  console.log(`   health flip sequence:       ${healthFlips.join(' → ')}`);
  console.log(`   background_tasks_changed:   ${bgLines}`);
  console.log(`   scenario 1 (bubble+dots):   hits=${bubbleAboveDots} firstAt=${JSON.stringify(firstBubbleAboveDotsAt)}s`);
  console.log(`   scenario 2 (dark mid-turn): hits=${darkMidTurn} withMsg=${msgWhileDark} firstAt=${JSON.stringify(firstDarkMidTurnAt)}s`);
  console.log(`   plan written:               ${planWritten}`);
  const chatHealth = logs.filter((e) => e.scope === 'chat.health' || e.scope === 'chat.healthPoll');
  if (chatHealth.length) {
    console.log('[E2E] ---- client health decisions ----');
    for (const e of chatHealth) console.log('   ' + evline(e));
  }

  // ---- Preconditions: the scenario actually reproduced (else the pass is empty) ----
  expect(turnStarts, 'the planning turn actually started').toBeGreaterThan(0);
  expect(sawWork, 'the SDK reported the session working at some point').toBe(true);
  expect(dotsFirstIdx, 'the dots appeared at some point during the turn').toBeGreaterThanOrEqual(0);

  // ---- Invariants (REPRO: these FAIL on current code when the bug fires) ----
  // A mid-turn processing↔idle flip (more than one processing/idle pair for a
  // single user prompt) is the server-side smoking gun for scenario 2; logged for
  // correlation but the DOM samples are what the assertions bind to.
  expect(
    bubbleAboveDots,
    `scenario 1: an intermediary bubble rendered above the dots (first at ${JSON.stringify(firstBubbleAboveDotsAt)}s) — an in-flight partial leaked past stripInFlightPartials`,
  ).toBe(0);
  expect(
    darkMidTurn,
    `scenario 2: the dots went dark mid-turn after having appeared (first at ${JSON.stringify(firstDarkMidTurnAt)}s, ${msgWhileDark} of those with a message showing) — dots torn down while the turn was still working`,
  ).toBe(0);
});
