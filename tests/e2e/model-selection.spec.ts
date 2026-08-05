/**
 * End-to-end: the model picker actually changes which model serves the session.
 *
 * Shares the scaffolding of build-calculator.spec.ts (sibling project dir, PID
 * reaping, JSONL lookup via Fury's own sessionPaths) but deliberately uses
 * trivial one-word prompts: this test is about model IDENTITY, not real work,
 * so there's no reason to pay for a calculator build. Haiku is the target — the
 * cheapest model, and unambiguous to assert against a default of Opus.
 *
 * GROUND TRUTH is the transcript JSONL's per-message `message.model`, not the
 * status bar. The label is downstream of the same eventBus we're testing, so
 * asserting on it alone could pass while the CLI happily served a different
 * model. The JSONL is written by the CLI itself — it can't lie about which
 * model produced a turn.
 *
 * Covers both ways a model reaches the SDK, which are genuinely different code
 * paths (see sdkSessionManager.setModel / startQuery):
 *   1. LIVE   — Query.setModel() over the control protocol on a warm session.
 *   2. PENDING — no query open yet, so the choice is replayed into
 *                options.model when startQuery() opens one.
 *
 * COST/TIME: runs real Claude turns under <repo>/../fury-e2e-model (wiped each
 * run). Budget a couple of minutes.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findSessionJsonlDir } from '../../lib/sessionPaths';
import { loadSessionModel } from '../../lib/transcriptArchiver';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

// Sibling of the repo, not inside it — see build-calculator.spec.ts: with a cwd
// inside a git repo, Claude resolves relative writes against the REPO ROOT and
// pollutes Fury itself.
const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-model');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// NOTE: this test relies on Fury always starting on the Chat tab (app/page.tsx
// deliberately does not restore a persisted activeTab). It used to pin the tab
// over the API first, because the old persisted-tab restore landed after mount
// and could strand the run on Stats — where the Chat panel still renders, but
// hidden, so every locator resolves and then fails toBeVisible. If that
// regresses, this test fails at the sidebar lookup rather than papering over it.

const jsonlPath = (sessionId: string): string | null => {
  const loc = findSessionJsonlDir(sessionId, PROJECT);
  return loc ? join(loc.dir, `${sessionId}.jsonl`) : null;
};

/**
 * The wire model id of every assistant turn in the transcript, in order.
 * Skips '<synthetic>' (usage-limit notices / compaction stubs), mirroring
 * transcriptParser's own currentModel rule — a synthetic entry is not a turn
 * any model served.
 */
function assistantModels(sessionId: string): string[] {
  const p = jsonlPath(sessionId);
  if (!p || !existsSync(p)) return [];
  const out: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const m = e?.message?.model;
      if (e.type === 'assistant' && typeof m === 'string' && m && m !== '<synthetic>') out.push(m);
    } catch { /* partial line mid-write — skip */ }
  }
  return out;
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

/** poll(), for a predicate that has to await (e.g. a DB read). */
async function pollAsync(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Wait until a NEW assistant turn lands beyond `since` entries. Returns its model. */
async function waitForTurn(sessionId: string, since: number, timeoutMs = 120_000): Promise<string | null> {
  const got = await poll(() => {
    const models = assistantModels(sessionId);
    return models.length > since ? models : false;
  }, timeoutMs);
  return got ? got[got.length - 1] : null;
}

/** SIGKILL + remove PID files for every session whose entry matches. */
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

const createdSessions: string[] = [];

/** Mirrors playwright.config.ts's baseURL. afterAll gets no `request` fixture
 *  (it's test-scoped), so cleanup calls the server over plain fetch. */
const BASE_URL = 'http://localhost:3879';

test.afterAll(async () => {
  // Archive through the app's own endpoint. DELETE /api/session IS this cleanup,
  // done properly: it kills the process, flips the sessions row to 'archived',
  // removes the JSONL, and prunes history.jsonl — in that order, deliberately
  // (killing first stops a live turn writing the transcript mid-flip).
  //
  // This used to be hand-rolled below, which reimplemented three of those four
  // steps and silently skipped the status flip — so every run left an 'active'
  // row behind and the sidebar accumulated 14 dummy sessions before anyone
  // noticed. Don't re-hand-roll it; the route is the source of truth.
  //
  // Archive, not delete: the soft-delete keeps the transcript and usage_events,
  // so the tokens these runs genuinely spent still show in Stats. They just stop
  // cluttering the session list.
  for (const id of createdSessions) {
    try {
      await fetch(
        `${BASE_URL}/api/session?sessionId=${encodeURIComponent(id)}&project=${encodeURIComponent(PROJECT)}`,
        { method: 'DELETE' },
      );
    } catch { /* server already torn down — the disk fallback below still runs */ }
  }

  // Fallback for whatever the route couldn't reach: a run that died before the
  // session was registered, or a server that's already gone. All of these no-op
  // when the route already did the work.
  for (const id of createdSessions) {
    try { const p = jsonlPath(id); if (p) rmSync(p); } catch { /* best effort */ }
    reapPidFiles((e) => e.sessionId === id);
  }
  try {
    const histPath = join(homedir(), '.claude', 'history.jsonl');
    if (existsSync(histPath)) {
      const kept = readFileSync(histPath, 'utf8')
        .split('\n')
        .filter((l) => !createdSessions.some((id) => l.includes(id)));
      writeFileSync(histPath, kept.join('\n'));
    }
  } catch { /* best effort */ }
});

test.beforeAll(() => {
  // A prior failed run can leave a CLI process holding cwd=PROJECT.
  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-model'));
  for (let i = 0; i < 6; i++) {
    try { rmSync(PROJECT, { recursive: true, force: true }); break; }
    catch { /* held — retry */ }
  }
  mkdirSync(PROJECT, { recursive: true });
});

test('picker switches a live session to Haiku, and Haiku serves the next turn', async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessions.push(sessionId);
  console.log(`[E2E] session=${sessionId}  project=${PROJECT}`);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // ---- Turn 1: default model, trivial prompt ----
  // Establishes both a warm query (so setModel takes the LIVE path) and a
  // baseline model to prove the switch actually changed something.
  const res = await page.request.post('/api/claude-sdk', {
    data: {
      prompt: 'Reply with exactly the word READY. Do not use any tools. No explanation.',
      sessionId,
      projectPath: PROJECT,
    },
  });
  expect(res.ok(), '/api/claude-sdk should accept turn 1').toBe(true);

  const baseline = await waitForTurn(sessionId, 0);
  expect(baseline, 'turn 1 should record an assistant model in the JSONL').toBeTruthy();
  console.log(`[E2E] Turn 1 served by: ${baseline}`);
  // Guard the premise: if the default were already Haiku the switch would be a
  // no-op and the headline assertion below would pass for the wrong reason.
  expect(baseline, 'default must not already be Haiku or the test proves nothing').not.toMatch(/haiku/i);

  // ---- Open the session so the model label (and picker) render ----
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const row = page.locator('.group\\/session').filter({ hasText: 'Reply with exactly the word READY' }).first();
  await expect(row, 'session should appear in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('send-button'), 'viewing the session shows the composer').toBeVisible({ timeout: 20_000 });

  // ---- Open the picker ----
  const label = page.getByTestId('model-label');
  await expect(label, 'status bar should show the model label').toBeVisible({ timeout: 20_000 });
  // The label renders as soon as providerSource lands, but currentModel arrives
  // from a SEPARATE transcript fetch — until then it shows the bare "Claude"
  // fallback. Wait for a resolved model before reading it, or the "before"
  // value is a race AND a formatModelName regression (which has happened:
  // Sonnet 5 / Fable 5 both scored null once) would hide behind the fallback.
  await expect(
    label,
    'label should resolve the running model, not sit on the bare "Claude" fallback',
  ).not.toContainText(/^Claude \(/, { timeout: 20_000 });
  console.log(`[E2E] label before switch: "${await label.textContent()}"`);
  await label.click();

  // Scope to the picker by title: clicking Select opens a SECOND dialog (the
  // confirm step), so a bare getByRole('dialog') goes ambiguous under strict mode.
  const dialog = page.getByRole('dialog').filter({ hasText: 'Select model' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  // Wait for the catalog fetch to land before asserting on row COUNTS. Counting
  // an empty list passes vacuously for "no duplicates" and fails confusingly for
  // "exactly one" — and the first run after a code edit pays a dev-server
  // recompile that can outlast the default 5s auto-retry. Gate on content first.
  await expect(
    dialog.locator('input[type="radio"]').first(),
    'model catalog should load',
  ).toBeVisible({ timeout: 20_000 });

  // ---- Regression guard: no duplicate Opus row ----
  // The catalog's 'default' alias arrives byte-identical to whichever real row
  // it points at (same resolvedModel, same description), so rendering it listed
  // Opus twice. It's now dropped and shown as a "(current default)" annotation.
  await expect(
    dialog.locator('label').filter({ hasText: 'Opus' }),
    'the default alias must not render as a second Opus row',
  ).toHaveCount(1);
  await expect(
    dialog.locator('label').filter({ hasText: /^Default/ }),
    'the default alias is not a model and must not be its own row',
  ).toHaveCount(0);
  await expect(
    dialog.getByText('(current default)'),
    'exactly one row is annotated as the current default',
  ).toHaveCount(1);

  // ---- Order: most capable first ----
  const names = await dialog.locator('label').locator('.text-sm.font-medium').allInnerTexts();
  const order = names.map(n => n.split('\n')[0].trim());
  console.log(`[E2E] picker order: ${JSON.stringify(order)}`);
  expect(order, 'models render most-capable-first').toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku']);

  // ---- Regression guard: exactly ONE "active" badge ----
  // 'default' and 'opus[1m]' both resolve to the same wire id, so matching on
  // resolvedModel alone badged two rows while Opus was serving.
  await expect(dialog.getByText('active', { exact: true }), 'exactly one row may be badged active').toHaveCount(1);

  // ---- Style guard: house pattern is native radios (AskUserQuestionDialog) ----
  const radios = dialog.locator('input[type="radio"]');
  expect(await radios.count(), 'picker should render native radios, not custom buttons').toBeGreaterThan(1);

  // ---- Select Haiku ----
  const haikuRow = dialog.locator('label').filter({ hasText: 'Haiku' }).first();
  await expect(haikuRow, 'catalog should offer Haiku').toBeVisible();
  await haikuRow.locator('input[type="radio"]').check();
  await dialog.getByRole('button', { name: 'Select' }).click();

  // ---- Always-confirm step ----
  // A model switch invalidates the prompt cache in full, so the next turn
  // re-processes the conversation at cache-write rates. That's invisible at
  // click time and only shows up later as a cache_write spike in Stats — the
  // confirm exists to make it visible, so assert it actually explains itself.
  const confirm = page.getByRole('dialog').filter({ hasText: 'Switch to' });
  await expect(confirm, 'switching should require confirmation').toBeVisible({ timeout: 10_000 });
  await expect(confirm, 'confirm must explain the cache reset').toContainText(/cache/i);
  await confirm.getByRole('button', { name: 'Switch', exact: true }).click();

  await expect(dialog, 'picker should close on a successful switch').not.toBeVisible({ timeout: 15_000 });

  // ---- The label reflects the switch immediately ----
  // Exercises setModel's resolved-id emit (the alias 'haiku' would format to a
  // bare "Claude") AND formatModelName's optional minor segment.
  await expect(label, 'status bar should show Haiku right after the switch').toContainText(/Haiku/i, { timeout: 15_000 });
  console.log(`[E2E] label after switch: "${await label.textContent()}"`);

  // ---- HEADLINE: the next turn is actually served by Haiku ----
  const before = assistantModels(sessionId).length;
  const res2 = await page.request.post('/api/claude-sdk', {
    data: {
      prompt: 'Reply with exactly the word DONE. Do not use any tools. No explanation.',
      sessionId,
      projectPath: PROJECT,
    },
  });
  expect(res2.ok(), '/api/claude-sdk should accept turn 2').toBe(true);

  const served = await waitForTurn(sessionId, before);
  console.log(`[E2E] Turn 2 served by: ${served}  (baseline was ${baseline})`);
  expect(served, 'turn 2 must be served by Haiku — proves setModel reached the CLI').toMatch(/haiku/i);

  // ---- Durability: the override outlives the process ----
  // The override lives in sdkSessionManager's in-memory map, so without a
  // persisted copy a restart silently reverts the session to the default on its
  // next turn. setModel writes it to sessions.metadata; the result handler
  // re-persists until the row exists (it usually doesn't at the first result).
  // The picker pins the CONCRETE version id the catalog offered (e.g.
  // claude-haiku-4-5-20251001), not the floating 'haiku' alias — pinning a
  // specific version is the point of the version dropdown. Match the family
  // prefix so a future dated snapshot doesn't break the assertion.
  const onDisk = await pollAsync(async () => /^claude-haiku/.test((await loadSessionModel(sessionId)) ?? ''), 30_000);
  console.log(`[E2E] override persisted to sessions.metadata: ${onDisk}`);
  expect(onDisk, 'the override must be persisted, or a restart loses it').toBe(true);

  // Read it back the way a RESTARTED server would. This test runs in its own
  // process, so this import is a second manager instance with an empty session
  // map — the same state a fresh boot is in. It therefore cannot answer from
  // memory and has to hydrate from the DB, which is the path that matters.
  const afterRestart = await sdkSessionManager.listModels(sessionId);
  console.log(
    `[E2E] fresh-process listModels current=${afterRestart.current} contextTokens=${afterRestart.contextTokens}`,
  );
  expect(
    afterRestart.current ?? '',
    'a restarted server must still report the pinned Haiku version, not Default',
  ).toMatch(/^claude-haiku/);
  // contextTokens must read through too, not just the override: it drives the
  // confirm step's cost line AND its window-overflow warning, so a 0 here
  // silently strips both — on precisely the long-lived session you reopened
  // after a restart, which is the case that dialog exists to warn about.
  expect(
    afterRestart.contextTokens,
    'a restarted server must still know the context size, or the confirm step loses its cost + overflow warning',
  ).toBeGreaterThan(0);
});

test('a model chosen before the first send is replayed into the new query', async ({ page }) => {
  test.setTimeout(4 * 60 * 1000);

  // A session with no query open yet — the map has no entry, so setModel can't
  // take the live path. This is the case a UI-only test would miss entirely:
  // the choice has to survive as session state and be replayed into
  // options.model when startQuery() finally opens the query.
  const sessionId = randomUUID();
  createdSessions.push(sessionId);
  console.log(`[E2E] pending-path session=${sessionId}`);

  const set = await page.request.post('/api/claude-sdk/model', {
    data: { sessionId, model: 'haiku' },
  });
  expect(set.ok(), 'POST /api/claude-sdk/model should accept').toBe(true);
  expect((await set.json()).applied, 'no query is open, so the choice must be recorded as pending').toBe('pending');

  // Read it back — the override must be visible before any turn runs.
  const got = await (await page.request.get(`/api/claude-sdk/model?sessionId=${sessionId}`)).json();
  expect(got.current, 'the pending override should round-trip').toBe('haiku');

  const res = await page.request.post('/api/claude-sdk', {
    data: {
      prompt: 'Reply with exactly the word HELLO. Do not use any tools. No explanation.',
      sessionId,
      projectPath: PROJECT,
    },
  });
  expect(res.ok(), '/api/claude-sdk should accept the turn').toBe(true);

  const served = await waitForTurn(sessionId, 0);
  console.log(`[E2E] pending-path turn served by: ${served}`);
  expect(served, 'the FIRST turn must be served by Haiku — proves options.model replay').toMatch(/haiku/i);
});
