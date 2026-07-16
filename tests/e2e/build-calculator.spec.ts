/**
 * End-to-end: Fury (SDK session path) actually builds an app, then a mid-flight
 * stop + rewind reverts the code changes.
 *
 * Drives the same endpoints the UI calls — /api/claude-sdk (send),
 * /api/claude-sdk/interrupt (stop), /api/claude-sdk/rewind (revert) — with the
 * page open for visibility. This is the reliable pattern the repo already uses
 * for backend-heavy flows (see tests/live-sessions/resume-cleaned-session.spec.ts):
 * clicking through non-deterministic LLM output is far flakier than asserting
 * on the real filesystem + transcript outcomes.
 *
 * Targets the SDK prototype path deliberately: the shipping rewind
 * (ChatTab.tsx handleRewind → PATCH /api/session) just asks the LLM to "undo
 * its changes", which can't be asserted deterministically. The SDK's
 * rewindFiles() is a real checkpoint revert (proven in scripts/verify-rewind.ts).
 *
 * COST/TIME: runs real Claude turns and writes real files under
 * <repo>/../fury-e2e-calc (wiped + recreated each run). Budget several minutes.
 */
import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findSessionJsonlDir } from '../../lib/sessionPaths';

// Resolved relative to the repo, so the test is machine-independent (no
// absolute home paths — works on macOS + Windows).
//
// Deliberately a SIBLING of the repo, not a directory inside it: when the cwd
// sits inside a git repo, Claude Code resolves relative writes against the REPO
// ROOT rather than the cwd. An in-repo path (e.g. test-results/calc) therefore
// writes calculator.js into Fury itself — the project dir stays empty, the test
// fails, and the repo gets polluted. Verified empirically; keep this outside.
const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-calc');
const CALC = join(PROJECT, 'calculator.js');

// Resolve the transcript through Fury's own lookup instead of hand-deriving the
// project slug: the CLI's slugification has edge cases (it also collapses
// underscores, e.g. `_probe` -> `-probe`) and canonicalizes cwd (symlinks,
// Windows subst drives). Returns null once the JSONL is gone.
const jsonlPath = (sessionId: string): string | null => {
  const loc = findSessionJsonlDir(sessionId, PROJECT);
  return loc ? join(loc.dir, `${sessionId}.jsonl`) : null;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Recursive path->sha map of a dir, skipping VCS/checkpoint/node noise. */
function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git' || name === 'node_modules' || name === '.claude') continue;
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out.set(r, sha(readFileSync(abs, 'utf8')));
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

function snapshotsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

async function poll<T>(fn: () => T | null | false, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await sleep(intervalMs);
  }
  return null;
}

/** Wait until the dir stops changing for `quietMs` (proxy for "turn settled"). */
async function waitForStable(dir: string, quietMs: number, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  let prev = snapshotDir(dir);
  let quietSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    const now = snapshotDir(dir);
    if (snapshotsEqual(prev, now) && now.size > 0) {
      if (Date.now() - quietSince >= quietMs) return true;
    } else {
      quietSince = Date.now();
      prev = now;
    }
  }
  return false;
}

/** SIGKILL + remove PID files for every session whose entry matches. Returns count. */
function reapPidFiles(match: (entry: any) => boolean): number {
  const dir = join(homedir(), '.claude', 'sessions');
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = join(dir, f);
    try {
      const e = JSON.parse(readFileSync(full, 'utf8'));
      if (match(e) && typeof e.pid === 'number') {
        try { process.kill(e.pid, 'SIGKILL'); } catch { /* already dead */ }
        try { rmSync(full); } catch { /* leave stale */ }
        n++;
      }
    } catch { /* skip */ }
  }
  return n;
}

/** Alive OS pids of any CLI process registered to this session (via PID files). */
function liveProcsForSession(sessionId: string): number[] {
  const dir = join(homedir(), '.claude', 'sessions');
  if (!existsSync(dir)) return [];
  const alive: number[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e.sessionId === sessionId && typeof e.pid === 'number') {
        try { process.kill(e.pid, 0); alive.push(e.pid); } catch { /* dead */ }
      }
    } catch { /* skip */ }
  }
  return alive;
}

// Session created by the test, cleaned up afterward so re-runs don't accumulate
// rows in ~/.claude. The built calculator app is intentionally left on disk.
let createdSessionId: string | null = null;

test.afterAll(() => {
  if (!createdSessionId) return;
  try {
    const jsonl = jsonlPath(createdSessionId);
    if (jsonl) rmSync(jsonl);
  } catch { /* best effort */ }
  try {
    const histPath = join(homedir(), '.claude', 'history.jsonl');
    if (existsSync(histPath)) {
      const kept = readFileSync(histPath, 'utf8').split('\n').filter((l) => !l.includes(createdSessionId!));
      writeFileSync(histPath, kept.join('\n'));
    }
  } catch { /* best effort */ }
  // If the test failed before the UI delete, the SDK process is still alive.
  // KILL it (not just unlink the PID file) so it can't linger holding the
  // calculator dir and break the next run's clean slate.
  reapPidFiles((e) => e.sessionId === createdSessionId);
});

test('Fury builds a calculator, then stop + rewind reverts the refinement', async ({ page }) => {
  test.setTimeout(8 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;
  const post = async (path: string, data: unknown) => {
    const res = await page.request.post(path, { data });
    expect(res.ok(), `${path} should accept`).toBe(true);
    return res;
  };

  // ---- clean slate ----
  // A prior failed run can leave an orphaned CLI process holding cwd=calc.
  // Reap any first, then remove the dir with a short retry.
  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-calc'));
  for (let i = 0; i < 6; i++) {
    try { rmSync(PROJECT, { recursive: true, force: true }); break; }
    catch { await sleep(500); }
  }
  mkdirSync(PROJECT, { recursive: true });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  // ---- Turn 1: build the calculator ----
  console.log('[E2E] Turn 1: create calculator.js');
  await post('/api/claude-sdk', {
    prompt:
      'Create a Node.js calculator. Create a file named exactly calculator.js that ' +
      'exports four functions: add, subtract, multiply, divide (module.exports). ' +
      'Keep it minimal, no dependencies. Do not create any other files. No explanation.',
    sessionId,
    projectPath: PROJECT,
  });

  const built = await poll(
    () => existsSync(CALC) && /divide/.test(readFileSync(CALC, 'utf8')) ? true : false,
    240_000,
  );
  expect(built, 'calculator.js with a divide fn should be created').toBe(true);
  expect(await waitForStable(PROJECT, 4000, 60_000), 'turn 1 should settle').toBe(true);

  const t1 = snapshotDir(PROJECT);
  const t1Calc = readFileSync(CALC, 'utf8');
  console.log(`[E2E] Turn 1 done. files=[${[...t1.keys()].join(', ')}]`);
  expect(t1Calc).toMatch(/add/);
  expect(t1Calc).toMatch(/divide/);

  // ---- Open the session in the UI so the real stop/rewind controls render ----
  // Sends stay on the API for determinism, but STOP and REWIND are driven
  // through the actual UI (data-testid controls) to exercise the wired SDK
  // handlers end-to-end: handleTranscriptStop → /api/claude-sdk/interrupt and
  // handleRewind('both') → /api/claude-sdk/rewind.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const openRow = page.locator('.group\\/session').filter({ hasText: 'Create a Node.js calculator' }).first();
  await expect(openRow, 'session should appear in the sidebar').toBeVisible({ timeout: 30_000 });
  await openRow.click();
  await expect(page.getByTestId('send-button'), 'viewing the session shows the composer').toBeVisible({ timeout: 20_000 });

  // ---- Turn 2: refinement, then STOP via UI (best-effort mid-flight) ----
  // Catching a real LLM turn mid-flight is inherently racy (the SDK often
  // finishes the edit in ~10s), so the Stop click is best-effort: if the turn
  // already completed, the button is gone and the rewind below still reverts
  // the change deterministically (that's the load-bearing assertion). When the
  // window is caught, this exercises handleTranscriptStop → interrupt.
  console.log('[E2E] Turn 2: add power + modulo + docs');
  const turn2Prompt =
    'Modify calculator.js: add two more exported functions, power(base, exp) and ' +
    'modulo(a, b), keeping the existing four. Also add a detailed JSDoc block above ' +
    'every one of the six functions and add input validation (throw a TypeError on ' +
    'non-number arguments) to each. Edit only calculator.js. No explanation.';
  await post('/api/claude-sdk', { prompt: turn2Prompt, sessionId, projectPath: PROJECT });

  // ---- Regression guard: the SDK session must expose a stream buffer ----
  // sendMessage opens the buffer synchronously, so it exists as soon as the POST
  // returns. Without it /api/stream-buffer reports hasBuffer:false, ChatTab skips
  // the branch that strips the in-flight turn's partial assistant messages from
  // the JSONL, and opening/reloading the session mid-turn renders intermediary
  // assistant bubbles between the user prompt and the bouncing dots (it also
  // loses stream restore: text, tool events, elapsed timer).
  const buf = await (await page.request.get(`/api/stream-buffer?sessionId=${sessionId}`)).json();
  console.log(`[E2E] stream-buffer mid-turn: hasBuffer=${buf.hasBuffer} isActive=${buf.isActive} isProcessing=${buf.isProcessing}`);
  expect(buf.hasBuffer, 'SDK session must expose a stream buffer').toBe(true);
  expect(buf.isActive, 'buffer must be active mid-turn (gates the strip)').toBe(true);
  expect(buf.isProcessing, 'buffer must report processing').toBe(true);
  expect(buf.userPrompt, 'userPrompt must match exactly — the strip anchors on it').toBe(turn2Prompt);

  // ---- Regression guard: processing indicator + live stream must render ----
  // Both are gated on transcriptLoading. On the SDK branch they vanished because
  // /api/stream-buffer (and /api/health) queried only the CLI sessionManager, so
  // they reported isProcessing:false for SDK sessions; ChatTab's stream-buffer
  // poll then cleared transcriptLoading — removing the bouncing dots AND dropping
  // every session-stream event. Verify both render AND that the indicator
  // PERSISTS across poll intervals (the bug cleared it within ~1-2s).
  const dots = page.getByTestId('processing-dots');
  await expect(dots, 'bouncing dots should appear during an SDK turn').toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('stream-event').first(), 'Stream tab should show live tool events').toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(4000); // let the stream-buffer poll fire several times
  await expect(dots, 'indicator must persist (not be cleared by the stream-buffer poll)').toBeVisible();
  const streamCount = await page.getByTestId('stream-event').count();
  console.log(`[E2E] processing dots persisted + ${streamCount} stream event(s) rendered`);

  // Click the real Stop button the moment it's visible (as early as possible to
  // win the race), as long as a change has already landed to revert.
  const stopBtn = page.getByTestId('stop-button');
  let clickedStop = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    const changed = !snapshotsEqual(snapshotDir(PROJECT), t1);
    if (changed && await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click().catch(() => {});
      clickedStop = true;
      break;
    }
    // Turn finished (composer back) with a change already on disk → done racing.
    if (changed && await page.getByTestId('send-button').isVisible().catch(() => false)) break;
    await sleep(250);
  }
  expect(!snapshotsEqual(snapshotDir(PROJECT), t1), 'turn 2 should modify files').toBe(true);
  console.log(`[E2E] Stop via UI clicked mid-flight? ${clickedStop}  (power now? ${/power/.test(readFileSync(CALC, 'utf8'))})`);

  // Processing ends → composer returns and the UI refreshes the transcript from
  // JSONL (turn-2 user message + its uuid, which the SDK rewind targets).
  await expect(page.getByTestId('send-button'), 'composer returns').toBeVisible({ timeout: 30_000 });

  // ---- REWIND via UI: turn-2 rewind button → "Conversation + Code" ----
  console.log('[E2E] Rewind via UI: rewind-turn-1 → "Conversation + Code"');
  const rewindBtn = page.getByTestId('rewind-turn-1');
  await rewindBtn.waitFor({ state: 'attached', timeout: 20_000 });
  await rewindBtn.click({ force: true }); // opacity-0 until hover
  const rewindDialog = page.getByRole('dialog');
  await expect(rewindDialog).toBeVisible();
  await rewindDialog.getByRole('button', { name: 'Conversation + Code' }).click();

  // ---- Verify: code reverted to the turn-1 state ----
  await waitForStable(PROJECT, 1500, 30_000);
  const finalCalc = existsSync(CALC) ? readFileSync(CALC, 'utf8') : '(missing)';
  console.log(`[E2E] After rewind: calculator.js has power? ${/power/.test(finalCalc)}`);

  // Headline assertion: the refinement's code changes are gone.
  expect(finalCalc, 'calculator.js should be byte-identical to its turn-1 content').toBe(t1Calc);
  // And the whole tree matches the turn-1 snapshot (new files, if any, removed).
  expect(snapshotsEqual(snapshotDir(PROJECT), t1), 'working tree should match turn-1 snapshot').toBe(true);

  // ---- Delete via the real UI, and verify the warm process is killed ----
  // The session is idle now (interrupted before rewind), so its warm SDK
  // process is alive but NOT "live" — exactly the leak the delete must clean up.
  const procsBefore = liveProcsForSession(sessionId);
  console.log(`[E2E] live process(es) for session before delete: [${procsBefore.join(', ')}]`);
  expect(procsBefore.length, 'session should have a live CLI process before delete').toBeGreaterThan(0);

  // Reload so the sidebar reflects the current (idle → non-live) state; the
  // rename/delete hover buttons only render on non-live rows.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // Find the session row by its auto-display (the turn-1 prompt).
  const rowByDisplay = page.locator('.group\\/session').filter({ hasText: 'Create a Node.js calculator' });
  await expect(rowByDisplay.first(), 'session should appear in the Sessions list').toBeVisible({ timeout: 30_000 });
  const row = rowByDisplay.first();

  // Rename it (the user's suggestion — makes it unambiguous to locate).
  const label = `E2E-DELETE-${sessionId.slice(0, 8)}`;
  console.log(`[E2E] Renaming session → "${label}"`);
  await row.hover();
  await row.locator('button[title="Edit label"]').click();
  const labelDialog = page.getByRole('dialog');
  await labelDialog.getByRole('textbox').fill(label);
  await labelDialog.getByRole('button', { name: 'Save' }).click();

  // Now locate by the label and delete it through the UI.
  const labeledRow = page.locator('.group\\/session').filter({ hasText: label });
  await expect(labeledRow, 'renamed session should show its label').toBeVisible({ timeout: 15_000 });
  console.log('[E2E] Clicking Delete → confirm');
  await labeledRow.hover();
  await labeledRow.locator('button[title="Delete session"]').click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('Delete session?');
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

  // ---- Verify: row gone, process killed, transcript deleted ----
  await expect(labeledRow, 'row should disappear after delete').toHaveCount(0, { timeout: 15_000 });

  const dead = await poll(() => liveProcsForSession(sessionId).length === 0, 20_000, 300);
  console.log(`[E2E] After UI delete: live process(es) = [${liveProcsForSession(sessionId).join(', ')}]`);
  expect(dead, 'deleting the session should kill its warm CLI process(es)').toBe(true);
  expect(jsonlPath(sessionId), 'session JSONL should be deleted').toBeNull();
});
