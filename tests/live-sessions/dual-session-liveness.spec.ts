/**
 * Dual-session liveness drive — the acceptance gate for the SSOT liveness work
 * (docs/design-liveness-single-source-of-truth.md, and the "Verification test
 * requirements" section of docs/review-dots-desync-fix.md).
 *
 * WHY TWO SESSIONS. Every prior drive watched only the DRIVEN session. But the bug
 * we actually hit (reproduced organically in `f407574a`) is a property of the PAIR:
 *
 *   - OWNER session O launches a drive as a `run_in_background` Bash and ENDS its
 *     turn — its cross-turn-liveness surface: a detached shell that outlives the turn
 *     MUST keep reading as live for the grace window. (This was the inverse — Defect A,
 *     "a shell is not Claude work" — until the 2026-08-21 decision in
 *     docs/ticket-live-badge-flicker-quiet-background-task.md reversed it.)
 *   - DRIVEN session T fans out PARALLEL FOREGROUND scouts against real Gypsy — its
 *     scenario-2 surface: the dots/phase must not go dark mid-turn.
 *
 * Neither is visible watching one session alone; they co-occur only in the real
 * topology. This spec monitors BOTH threads on one timeline via the single liveness
 * projection (`/api/health.liveness`, PULL) correlated with the `sdk.health` PUSH
 * lines in the fury-logs (which carry `phase`/`seq` since the step-1 drop).
 *
 * PUSH capture note: rather than run a fragile Node SSE client, we read the PUSH
 * stream from the fury-logs — `emitHealth` logs `sdk.health {phase,seq,...}` on the
 * SAME call that emits the `session:health` SSE, so the log is a faithful PUSH record.
 *
 * EXPECTATIONS vs current code (post step-1 + its review follow-ups):
 *   - Assertions 1, 3, 4, 5, 6 assert PROJECTION-level invariants that MUST hold on
 *     current code; they are hard.
 *   - Assertion 2's PROJECTION check (T stays main-turn) is hard. Its DOM check (dots
 *     lit / no bubble) is the STEP-2 acceptance gate — the client isn't wired to
 *     `liveness` yet, so DOM still follows the legacy path. It is recorded always and
 *     asserted only under STEP2=1, so this suite stays green pre-step-2 and becomes
 *     the gate once the client switch lands.
 *   - Assertion 1 records the raw `task_type` a `run_in_background` Bash arrives as,
 *     and asserts such a set reads as LIVE once the main turn is idle. It formerly
 *     asserted the opposite (Defect A) and formerly failed if the set was classified
 *     agentic; that Finding-3 check is what pinned the real wire value as
 *     `local_bash`, and both were reversed by the 2026-08-21 decision in
 *     docs/ticket-live-badge-flicker-quiet-background-task.md.
 *
 * COST/TIME: two real multi-minute turns (a planning fan-out + a background bash).
 * Budget ~12 min and a few dollars. Lives in tests/live-sessions (costly), gated on
 * the real Gypsy codebase being present.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn, cleanupSession, BASE_URL,
} from './drive-helpers';

const STEP2 = process.env.STEP2 === '1'; // when the client renders `liveness`, gate the DOM checks

// Repo-parent scratch dirs (same convention as the sibling drives).
const PROJECT_T = join(__dirname, '..', '..', '..', 'fury-e2e-dual-driven');
const PROJECT_O = join(__dirname, '..', '..', '..', 'fury-e2e-dual-owner');
const GYPSY = 'C:\\Users\\petya\\Documents\\Java\\Web Projects\\Gypsy';

// ---- Driven (T): the scout-planning fixture from planning-scouts-inflight.spec.ts,
//      kept self-contained here on purpose (a costly spec shouldn't import another). ----
const T_CLAUDE_MD = `# Planner — Gypsy → Node/React migration

You are a PLANNER. Your job is to produce a migration plan, NOT to read source code
into this (main) thread. You DELEGATE all code reading to the \`scout\` subagent.

## Hard rules — follow EXACTLY
1. You may NOT Read/Grep/Glob source files yourself. To understand ANY part of the
   target codebase you MUST launch a \`scout\` subagent and act only on its summary.
2. Launch scouts in PARALLEL: put MULTIPLE Task(scout) tool calls in a SINGLE
   message — one scout per subsystem — and wait for them all. Do this at least TWICE
   (an initial survey, then a deeper pass on the areas the survey flags).
3. The target codebase is the Gypsy Java web app at:
   ${GYPSY}
   Its three subsystems are \`JTS/\`, \`WebApp/\`, and \`kartographia-map/\`.
4. After the scouts report, WRITE the plan to \`docs/PLAN-gypsy-node-react.md\`
   (create the docs/ dir). Keep the main thread lean.

## Scouts (one Task per subsystem, run concurrently)
- scout JTS/            → server/topology/geometry code: entry points, key classes.
- scout WebApp/         → the web layer: endpoints, servlets/JSP, JS front-end.
- scout kartographia-map/→ the mapping library: public API surface, dependencies.
`;

const SCOUT_MD = `---
name: scout
description: >-
  Reads code and returns a tight summary with file:line references. Use for ANY
  multi-file exploration so raw file content never enters the main thread's context.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a scout. Explore the codebase and return the smallest answer that lets the
main thread act — never paste files back. Locate first (Grep/Glob), then read only the
specific ranges you need. Return a concise synthesis with exact \`path:line\`
references. You are read-only. State what you did NOT check.
`;

const T_KICKOFF =
  'Read CLAUDE.md and produce the Gypsy → Node/React migration plan EXACTLY as it ' +
  'specifies. Start by launching parallel scout subagents (one per subsystem, all in ' +
  'one message), wait for their summaries, do a second deeper parallel scout pass, ' +
  'then write docs/PLAN-gypsy-node-react.md. Do not read source files into this thread.';

// ---- Owner (O): launch ONE detached run_in_background bash, then END the turn. This
//      is the f407574a topology — the Fury session that kicked off a background drive
//      and went idle while it ran. The long sleep outlives the observation window. ----
const O_CLAUDE_MD = `# Owner — background launcher

Your ONLY job: launch exactly ONE long-running shell command in the BACKGROUND, then
stop. Do not tail it, do not launch subagents, do not do anything else.
`;

const O_KICKOFF =
  'Run this EXACT command in the background using the Bash tool with ' +
  'run_in_background set to true: `sleep 600`. Launch it and then IMMEDIATELY end ' +
  'your turn. Do NOT wait for it, do NOT run any other command, do NOT launch any ' +
  'subagents.';
// `sleep 600` deliberately outlives the entire observation window so the owner's
// detached-bash (Defect-A) window spans the whole driven planning turn by
// construction (Finding B) — never closing early and spuriously failing the overlap
// check. It is a bare `sleep`, so if a detached child outlives cleanup it exits on
// its own harmlessly (no CPU/resources); the CLI itself is reaped by cleanupSession.

function writeDrivenFixture(): void {
  mkdirSync(join(PROJECT_T, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(PROJECT_T, 'CLAUDE.md'), T_CLAUDE_MD);
  writeFileSync(join(PROJECT_T, '.claude', 'agents', 'scout.md'), SCOUT_MD);
}
function writeOwnerFixture(): void {
  mkdirSync(PROJECT_O, { recursive: true });
  writeFileSync(join(PROJECT_O, 'CLAUDE.md'), O_CLAUDE_MD);
}

let sidT: string | null = null;
let sidO: string | null = null;

test.afterAll(async () => {
  await cleanupSession(sidT, PROJECT_T);
  await cleanupSession(sidO, PROJECT_O);
});

const health = async (sessionId: string): Promise<any> => {
  try { return await (await fetch(`${BASE_URL}/api/health?sessionId=${sessionId}`)).json(); }
  catch { return {}; }
};

/** PUSH records from the fury-logs: emitHealth logs `sdk.health {phase,seq}` on the
 *  same call that emits the session:health SSE — a faithful proxy for the PUSH. */
function pushHealth(sessionId: string): Array<{ ts: number; phase?: string; seq?: number; msg: string }> {
  return furyLogLinesFor(sessionId)
    .filter((e) => e.scope === 'sdk.health')
    .map((e) => ({ ts: e.ts, msg: e.msg, phase: e.data?.phase, seq: e.data?.seq }));
}

type Sample = {
  t: number; wall: number;
  phase?: string; seq?: number; startedAt?: number | null;
  mainTurnActive?: boolean; backgroundActive?: boolean; processAlive?: boolean;
  proc: boolean; bg: boolean;
  dots?: boolean; bubbles?: number; // T only (focused DOM)
};

function record(h: any, tSec: number): Sample {
  const lv = h?.liveness ?? {};
  return {
    t: tSec, wall: Date.now(),
    phase: lv.phase, seq: lv.seq, startedAt: lv.startedAt,
    mainTurnActive: lv.mainTurnActive, backgroundActive: lv.backgroundActive, processAlive: lv.processAlive,
    proc: !!h?.isProcessing, bg: !!h?.backgroundActive,
  };
}

test('dual-session liveness: owner-idle-with-bash + driven-scout-planning stay honest', async ({ page }) => {
  test.setTimeout(13 * 60 * 1000);

  expect(existsSync(GYPSY), `Gypsy codebase present at ${GYPSY}`).toBe(true);

  sidT = randomUUID();
  sidO = randomUUID();

  reapPidFiles((e) => {
    const cwd = String(e.cwd || '').replace(/\\/g, '/');
    return cwd.includes('/fury-e2e-dual-driven') || cwd.includes('/fury-e2e-dual-owner');
  });
  await Promise.all([resetProjectDir(PROJECT_T), resetProjectDir(PROJECT_O)]);
  writeDrivenFixture();
  writeOwnerFixture();

  // ---- Launch BOTH turns up front (Finding B): the owner's turn is a single
  //      background-launch-then-stop, so it goes idle within seconds while its
  //      `sleep 600` runs for the whole window — guaranteeing the Defect-A window
  //      overlaps the entire (multi-minute) driven planning turn instead of racing a
  //      short bash against a slow owner-ready wait. `ownerReady` is judged post-hoc
  //      from the samples, not a pre-wait that could itself burn the overlap. ----
  console.log(`[E2E] owner=${sidO}  driven=${sidT}`);
  const [oRes, tRes] = await Promise.all([
    driveTurn(sidO, PROJECT_O, O_KICKOFF),
    driveTurn(sidT, PROJECT_T, T_KICKOFF),
  ]);
  expect(oRes.ok, '/api/claude-sdk accepts the owner turn').toBe(true);
  expect(tRes.ok, '/api/claude-sdk accepts the driven turn').toBe(true);

  // Open the DRIVEN scout-planning session in the browser (focused) for the DOM checks.
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Read CLAUDE.md' }).first();
  await expect(row, 'driven session appears in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    page.getByTestId('send-button').or(page.getByTestId('stop-button')),
    'driven session view opened',
  ).toBeVisible({ timeout: 20_000 });

  const dots = page.getByTestId('processing-dots');
  const bubbles = page.getByTestId('claude-turn');
  await expect(dots, 'dots appear once the planning turn starts').toBeVisible({ timeout: 60_000 });

  // ---- 3) Unified sampling loop over BOTH sessions on one timeline (~1s). ----
  const samplesO: Sample[] = [];
  const samplesT: Sample[] = [];
  const t0 = Date.now();
  const DEADLINE = 10 * 60 * 1000;
  let tSawWork = false;
  let settled = 0;

  while (Date.now() - t0 < DEADLINE) {
    const tSec = Math.round((Date.now() - t0) / 1000);
    const [hO, hT, dotsVisible, bubbleCount] = await Promise.all([
      health(sidO),
      health(sidT),
      dots.isVisible().catch(() => false),
      bubbles.count().catch(() => 0),
    ]);
    const sO = record(hO, tSec);
    const sT = record(hT, tSec);
    sT.dots = dotsVisible;
    sT.bubbles = bubbleCount;
    samplesO.push(sO);
    samplesT.push(sT);

    const tWorking = sT.proc || sT.bg;
    if (tWorking) tSawWork = true;
    // End once the DRIVEN turn has fully settled (its planning is the long pole).
    if (tSawWork && !tWorking && !dotsVisible) {
      if (++settled > 20) break;
    } else settled = 0;
    await sleep(1000);
  }

  // ---- Correlation data ----
  const oBg = furyLogLinesFor(sidO).filter((e) => e.scope === 'sdk.bg' && e.msg === 'background tasks changed');
  const oBgActive = oBg.filter((e) => (e.data?.count ?? 0) >= 1);
  const observedShellTypes = [...new Set(oBgActive.flatMap((e) => (Array.isArray(e.data?.types) ? e.data.types : [])))];
  // The detached-bash window: [first non-empty set, first subsequent empty set).
  const bgStart = oBgActive[0]?.ts ?? Infinity;
  const bgClear = oBg.find((e) => e.ts > bgStart && (e.data?.count ?? 0) === 0)?.ts ?? Infinity;
  const inBashWindow = (wall: number) => wall >= bgStart && wall < bgClear;

  // The owner reached its Defect-A state iff it launched a bash AND we sampled it idle
  // inside that window — judged from the samples (not a pre-wait), so the check can't
  // itself consume the O/T overlap.
  const ownerReady = oBgActive.length > 0 && samplesO.some((s) => inBashWindow(s.wall) && s.mainTurnActive === false);

  const pushO = pushHealth(sidO);
  const pushT = pushHealth(sidT);
  // Correlates the PULL sample's wall-clock (Date.now() in the test process) with the
  // PUSH log line's `ts` (server clock). Sound because this drive runs the test and
  // the server on ONE host; if ever split across machines this comparison would skew
  // and needs a clock-offset correction.
  const latestPushPhaseAt = (push: ReturnType<typeof pushHealth>, wall: number): string | undefined => {
    let phase: string | undefined;
    for (const p of push) { if (p.ts <= wall && p.phase) phase = p.phase; }
    return phase;
  };

  console.log('\n[E2E] ===== SUMMARY =====');
  console.log(`   owner bg task_type(s):     ${JSON.stringify(observedShellTypes)}`);
  console.log(`   owner bg sets (count>=1):  ${oBgActive.length}`);
  console.log(`   owner samples:             ${samplesO.length}`);
  console.log(`   driven samples:            ${samplesT.length}  sawWork=${tSawWork}`);
  console.log(`   driven push phases:        ${pushT.map((p) => p.phase ?? p.msg).join(' → ')}`);

  // ---------------------------------------------------------------------------
  // Assertion 1 — OWNER: a detached bash outliving its turn IS "working".
  //
  // REVERSED on 2026-08-21 (docs/ticket-live-badge-flicker-quiet-background-task.md).
  // This assertion used to enforce Defect A — owner phase must be 'idle' while only a
  // detached bash ran — and to fail if such a set was classified agentic. Both are
  // now inverted: a backgrounded build / dev server / test run is work the user wants
  // shown as live, liveness no longer branches on task_type at all, and the
  // `hasAgentic` field this once asserted on no longer exists.
  //
  // The old Finding-3 check did its job before being retired: it is what pinned
  // `local_bash` as the real wire value for a `run_in_background` Bash — matching
  // neither 'shell' nor 'bash', hence the misclassification behind the 2026-08-20
  // incident. We still RECORD the observed types (the only live evidence of what the
  // compiled CLI emits) and now assert the opposite behaviour.
  // ---------------------------------------------------------------------------
  if (ownerReady && oBgActive.length) {
    // The owner's phase must be NON-idle for essentially the whole bash window while
    // its main turn is idle — that is the cross-turn liveness the decision bought.
    //
    // Tolerance: the wedge grace (WEDGED_BG_GRACE_MS, 120s) still self-heals a set
    // whose terminal signal is lost, and a bash that outlives the grace legitimately
    // goes dark at that point (a known, accepted gap — see the ticket). So require
    // the badge lit at the START of the idle-bash window rather than throughout.
    const idleBash = samplesO.filter((s) => inBashWindow(s.wall) && s.mainTurnActive === false);
    const early = idleBash.filter((s) => s.wall < bgStart + 60_000);
    const dark = early.filter((s) => s.phase === 'idle');
    expect(
      dark.length,
      `owner phase went idle while its detached bash was still running ` +
        `(task_type(s)=${JSON.stringify(observedShellTypes)}, first at ${dark[0]?.t}s) — ` +
        `a backgrounded shell must read as live for at least the grace window`,
    ).toBe(0);
  } else {
    console.warn('[E2E] SKIP assertion 1 (detached-bash liveness): owner never produced an idle-with-bash window');
  }

  // ---------------------------------------------------------------------------
  // Assertion 6 — startedAt is null in the background phase (guards the P2 the
  // step-1 review flagged; should PASS now that the fix landed).
  // ---------------------------------------------------------------------------
  for (const [name, samples] of [['owner', samplesO], ['driven', samplesT]] as const) {
    const bad = samples.filter((s) => s.phase === 'background' && s.startedAt != null);
    expect(
      bad.length,
      `${name}: liveness.startedAt was non-null in the 'background' phase ` +
        `(first at ${bad[0]?.t}s, startedAt=${bad[0]?.startedAt}) — a strip anchor on a finished turn`,
    ).toBe(0);
  }

  // ---------------------------------------------------------------------------
  // Assertion 4 — seq: PUSH strictly non-decreasing & advancing; PULL never exceeds
  // the latest PUSH.
  // ---------------------------------------------------------------------------
  for (const [name, push] of [['owner', pushO], ['driven', pushT]] as const) {
    const seqs = push.map((p) => p.seq).filter((n): n is number => typeof n === 'number');
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i], `${name}: PUSH seq regressed at #${i} (${seqs[i - 1]} → ${seqs[i]})`).toBeGreaterThanOrEqual(seqs[i - 1]);
    }
    if (seqs.length > 1) expect(seqs[seqs.length - 1], `${name}: PUSH seq never advanced`).toBeGreaterThan(seqs[0]);
  }
  for (const [name, samples, push] of [['owner', samplesO, pushO], ['driven', samplesT, pushT]] as const) {
    const maxPush = Math.max(0, ...push.map((p) => p.seq ?? 0));
    const ahead = samples.filter((s) => typeof s.seq === 'number' && s.seq > maxPush);
    expect(ahead.length, `${name}: a PULL seq (${ahead[0]?.seq}) exceeded the latest PUSH seq (${maxPush})`).toBe(0);
  }

  // ---------------------------------------------------------------------------
  // Assertion 3 — SSOT invariant: PULL phase agrees with the latest PUSH phase.
  // Sustained disagreement (>2 consecutive ticks) is a push/pull-drift regression.
  //
  // CAVEAT (Finding A): step 1 unifies the liveness COMPUTATION, but not its INPUT —
  // `deriveLiveness(s, mainTurnActive)` still takes `mainTurnActive` from the caller,
  // and the real `f407574a` drift was a transiently-WRONG input (isSessionProcessing()
  // false on a fresh singleton while the last PUSH said main-turn), not a computation
  // difference. With the step-2a heartbeat landed the drift is now BOUNDED, not gone: a
  // wrong-idle PULL is re-asserted by the next PUSH beat, so its lifetime is ≤1 beat
  // (~4 s) instead of the whole turn. Read a green here as "drift bounded to ≤1 beat,"
  // not "drift fixed" — the input-sourcing fix (mainTurnActive-from-stream; collapse
  // pull/push) is steps 3–4. The ≤2-tick tolerance below absorbs that ≤1-beat window.
  // ---------------------------------------------------------------------------
  for (const [name, samples, push] of [['owner', samplesO, pushO], ['driven', samplesT, pushT]] as const) {
    let run = 0, worst = 0, firstAt = -1;
    for (const s of samples) {
      const pushed = latestPushPhaseAt(push, s.wall);
      if (pushed && s.phase && pushed !== s.phase) {
        if (run === 0) firstAt = s.t;
        run++; worst = Math.max(worst, run);
      } else run = 0;
    }
    expect(
      worst,
      `${name}: PULL vs PUSH phase disagreed for ${worst} consecutive ticks (first at ${firstAt}s) — push/pull drift`,
    ).toBeLessThanOrEqual(2);
  }

  // ---------------------------------------------------------------------------
  // Assertion 5 — cross-session isolation: O's detached bash must not move T, and
  // T's scouts must not move O. Concretely: within O's bash window, T's phase is
  // driven only by T's own work, and O's phase stays idle whenever O's main turn is.
  // ---------------------------------------------------------------------------
  // NOTE: this used to assert O's phase was 'idle' throughout its bash window, which
  // silently doubled as a Defect A check. Since 2026-08-21 O is LEGITIMATELY non-idle
  // there (its detached bash counts as live), so that form would now always fail.
  // Narrow it to the actual leak signature: O may be 'background' for its own bash,
  // but it must never read 'main-turn' while O's main turn is demonstrably inactive —
  // that would mean T's turn bled into O's projection.
  const oLeaked = samplesO.filter((s) => inBashWindow(s.wall) && s.mainTurnActive === false && s.phase === 'main-turn');
  expect(oLeaked.length, `isolation: owner projected 'main-turn' while its own main turn was idle (T's work leaked into O?)`).toBe(0);
  // T being main-turn during O's bash window proves the two are independent streams.
  const tActiveDuringOwnerBash = samplesT.some((s) => inBashWindow(s.wall) && s.phase === 'main-turn');
  if (bgStart !== Infinity) {
    expect(tActiveDuringOwnerBash, 'isolation: expected the driven session to be working during the owner bash window (else the topology never overlapped)').toBe(true);
  }

  // ---------------------------------------------------------------------------
  // Assertion 2 — DRIVEN / scenario 2 (Finding 1). PROJECTION: T's phase stays
  // 'main-turn' continuously once it starts — no idle gap mid-turn. DOM: dots lit /
  // no bubble-above-dots — the STEP-2 acceptance gate (client not wired to liveness
  // yet), recorded always, asserted only under STEP2=1.
  // ---------------------------------------------------------------------------
  // Trim the trailing fully-idle run; [0,endIdx) is the mid-turn window.
  let endIdx = samplesT.length;
  for (let i = samplesT.length - 1; i >= 0; i--) {
    const s = samplesT[i];
    if (!s.proc && !s.bg && !s.dots) endIdx = i; else break;
  }
  const firstMain = samplesT.findIndex((s) => s.phase === 'main-turn');

  let projDarkMidTurn = 0;
  const projDarkAt: number[] = [];
  let domDark = 0, domBubbleAboveDots = 0;
  const domDarkAt: number[] = [];
  for (let i = firstMain >= 0 ? firstMain : 0; i < endIdx; i++) {
    const s = samplesT[i];
    // Projection: after the main turn began, it should not read idle mid-window.
    if (firstMain >= 0 && i > firstMain && s.phase === 'idle') { projDarkMidTurn++; if (projDarkAt.length < 3) projDarkAt.push(s.t); }
    // DOM diagnostics.
    if (s.dots === false) { domDark++; if (domDarkAt.length < 3) domDarkAt.push(s.t); }
    if (s.dots && (s.bubbles ?? 0) > 0) domBubbleAboveDots++;
  }

  expect(tSawWork, 'precondition: the driven session reported working').toBe(true);
  expect(firstMain, 'precondition: the driven session entered the main-turn phase').toBeGreaterThanOrEqual(0);

  console.log(`   scenario2 projection dark: ${projDarkMidTurn} (at ${JSON.stringify(projDarkAt)}s)`);
  console.log(`   scenario2 DOM dark / bubble-above-dots: ${domDark} / ${domBubbleAboveDots} (dark at ${JSON.stringify(domDarkAt)}s) [STEP2=${STEP2}]`);

  // Hard: the server projection must never drop to idle mid-turn.
  expect(
    projDarkMidTurn,
    `scenario 2 (projection): driven phase read 'idle' mid-turn (first at ${JSON.stringify(projDarkAt)}s) — push/pull drift or a wrong idle`,
  ).toBe(0);

  if (STEP2) {
    // Post client-switch acceptance gate: the DOM must now track the projection.
    expect(domBubbleAboveDots, `scenario 1 (DOM): a bubble rendered above the dots mid-turn`).toBe(0);
    expect(domDark, `scenario 2 (DOM): the dots went dark mid-turn`).toBe(0);
  }
});
