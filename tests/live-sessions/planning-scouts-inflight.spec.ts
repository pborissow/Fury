/**
 * Live drive guarding the two rendering invariants during scout-heavy PLANNING
 * sessions (distinct from the two existing drives, which use a
 * background-orchestrator + simple writes):
 *
 *   (1) No Claude bubble may render in the MAIN transcript flow ABOVE the
 *       bouncing dots while the logical task is in progress.
 *       → symptom: `claude-turn` count > 0 WHILE dots are visible.
 *   (2) No dark gap: the dots must stay lit for the whole logical task.
 *       → symptom: `processing-dots` hidden while the task is still working.
 *
 * TURN MODEL (2.1.26x — docs/ticket-subagent-notification-turns-intermediate-
 * bubbles.md): PLANNING's `scout` Task subagents run as BACKGROUND tasks. The
 * dispatching turn ENDS with a real committed `result` ("scouts dispatched,
 * waiting…"), and each scout completion's <task-notification> drives its OWN
 * turn — one user send produces MANY results (the 2026-09-04 repro: 1 send,
 * 7 results). Those intermediate turn-finals are REAL committed messages, so
 * the in-flight-partials strip cannot (and must not) remove them. The fix under
 * test is the logical-task ENVELOPE:
 *   - server: the liveness projection holds phase non-idle ('background') across
 *     result→notification-turn boundaries and carries `envelopeStartedAt`;
 *   - client: while the envelope is open, everything committed at/after that
 *     anchor is hidden from the main flow (reachable via the dots-bubble modal
 *     — which is EXEMPT from scenario 1: it renders no `claude-turn` nodes);
 *   - when the envelope closes, the transcript reveals the committed history.
 *
 * Originally written as a REPRODUCTION of the pre-envelope failure (wall-to-wall
 * scenario-1/2 hits: hits=261 / darkGap ticks at every boundary); the identical
 * assertions now serve as the regression guard for the envelope work.
 *
 * The read target is the FURY REPO ITSELF (the codebase these tests live in), so
 * the spec is PORTABLE — no machine-specific project needed — while the scouts
 * still get genuine, multi-minute work across three real subsystems (lib/, app/,
 * components/). The fixture project only holds a coercive CLAUDE.md + the
 * scout/plan-reader agents and points them at Fury by absolute path, read-only,
 * so the repo stays pristine (the plan is written into the fixture project).
 * (Previously targeted a personal Java codebase by absolute path — not portable.)
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
// rebuilt from scratch each run; Fury (the read target) is never written — the
// plan lands in the fixture project's own docs/.
const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-planning');
const TARGET = join(__dirname, '..', '..'); // the Fury repo itself — always present

// A planner CLAUDE.md that FORCES parallel foreground scouts and forbids reading
// source into the main thread — the exact shape that fans out sidechains while the
// main turn stays processing. Mirrors docs/workflow-enhancements.zip's agreement.
const CLAUDE_MD = `# Planner — Fury → Java-or-Python rewrite

You are a PLANNER. Your job is to produce a rewrite plan, NOT to read source
code into this (main) thread. Reading big things here is the main cost lever, so
you DELEGATE all code reading to the \`scout\` subagent.

## Hard rules — follow EXACTLY
1. You may NOT Read/Grep/Glob source files yourself. To understand ANY part of the
   target codebase you MUST launch a \`scout\` subagent and act only on its summary.
2. Launch scouts in PARALLEL: put MULTIPLE Task(scout) tool calls in a SINGLE
   message — one scout per subsystem — and wait for them all. Do this at least
   TWICE (an initial survey, then a deeper pass on the areas the survey flags).
3. The target codebase is Fury, a Next.js/React UI for Claude Code, at:
   ${TARGET}
   Its three subsystems are \`lib/\` (session/SDK backend, transcript parsing),
   \`app/\` (Next.js API routes + pages), and \`components/\` (the React UI).
   The target is READ-ONLY — never write into it.
4. After the scouts report, WRITE the plan to \`docs/PLAN-fury-rewrite.md\` in THIS
   project (create the docs/ dir). The plan must recommend Java or Python (pick
   per subsystem, justify briefly) and cover, per subsystem: what it does, the
   equivalent stack/libraries, rewrite order, and risks — with \`file:line\`
   anchors the scouts returned. Keep the main thread lean.

## Scouts (one Task per subsystem, run concurrently)
- scout lib/        → session management, SDK spawn path, transcript parsing: entry points, key modules.
- scout app/        → the API routes + pages: endpoints, request/response shapes.
- scout components/ → the React UI: main views, state flow, key components.
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
model: claude-haiku-4-5
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
model: claude-haiku-4-5
---
You turn a plan document into an ordered execution checklist for another agent.
Resolve each step to concrete \`path:line\` targets; flag ambiguities; list verify
commands. Read-only.
`;

const KICKOFF =
  'Read CLAUDE.md and produce the Fury → Java-or-Python rewrite plan EXACTLY as it ' +
  'specifies. Start by launching parallel scout subagents (one per subsystem, all ' +
  'in one message), wait for their summaries, do a second deeper parallel scout ' +
  'pass on whatever they flag as complex, then write docs/PLAN-fury-rewrite.md. ' +
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
  // (The target is the Fury repo itself, so this can only fail if the layout moves.)
  expect(existsSync(join(TARGET, 'lib')), `Fury lib/ present under ${TARGET}`).toBe(true);

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
  const planWritten = existsSync(join(PROJECT, 'docs', 'PLAN-fury-rewrite.md'));

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

  // ---- Invariants (the envelope regression guard) ----
  // NOTE on the log counts above: MANY turn starts/dones per user send is NORMAL
  // under the 2.1.26x turn model (each task-notification is its own turn) — the
  // health flip sequence is expected to run processing↔background↔processing, and
  // is logged purely for correlation. The DOM samples are what the assertions
  // bind to: while the logical task runs, its committed intermediate turn output
  // must stay OUT of the main flow (scenario 1 — the dots-bubble modal, which
  // renders no `claude-turn` nodes, is the sanctioned way to see it) and the
  // dots must never go dark at a notification-turn boundary (scenario 2 — the
  // server's expected-notification hold smooths those ticks).
  expect(
    bubbleAboveDots,
    `scenario 1: an assistant bubble rendered in the MAIN flow above the dots while the envelope was open (first at ${JSON.stringify(firstBubbleAboveDotsAt)}s) — an in-flight partial leaked OR a committed notification-turn message escaped the envelope slice`,
  ).toBe(0);
  expect(
    darkMidTurn,
    `scenario 2: the dots went dark mid-task after having appeared (first at ${JSON.stringify(firstDarkMidTurnAt)}s, ${msgWhileDark} of those with a message showing) — an idle flash at a notification-turn boundary escaped the smoothing`,
  ).toBe(0);

  // ---- Envelope close: the committed history is REVEALED once the task settles ----
  // The intermediate messages are part of the JSONL; final rendering is normal
  // (agreed direction §3). After the settle window the main flow must show the
  // conversation's Claude bubbles again — hiding must not outlive the envelope.
  await expect(
    bubbles.first(),
    'committed turns revealed in the main flow after the envelope closed',
  ).toBeVisible({ timeout: 30_000 });
});
