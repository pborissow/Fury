/**
 * End-to-end: the "New Session" wizard's model step (directory → model → create)
 * and its session-less model catalog.
 *
 * REGRESSION ORIGIN: adding sdkSessionManager.warmModels() without bumping
 * SINGLETON_VERSION left a running dev server on its OLD live instance (the
 * singleton is a globalThis-cached Proxy that only swaps when the version
 * changes). The proxy forwarded warmModels to that stale instance, so the
 * wizard's model step — which GETs /api/claude-sdk/model with no sessionId —
 * threw "sdkSessionManager.warmModels is not a function". Unit tests and a
 * standalone import missed it because they start a fresh process with no stale
 * singleton; only a long-lived server exhibits it. These tests hit the REAL
 * running server, which is the only way to catch it.
 *
 * Shares scaffolding with model-selection.spec.ts (sibling project dir, PID
 * reaping, JSONL lookup via Fury's own sessionPaths). Ground truth for "which
 * model served" is the transcript JSONL's per-message message.model.
 *
 * COST/TIME: the wizard test runs one trivial real Claude turn under
 * <repo>/../fury-e2e-model-wizard (wiped each run). Budget ~1 minute.
 */
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findSessionJsonlDir } from '../../lib/sessionPaths';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-model-wizard');
const BASE_URL = 'http://localhost:3879';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jsonlPath = (sessionId: string): string | null => {
  const loc = findSessionJsonlDir(sessionId, PROJECT);
  return loc ? join(loc.dir, `${sessionId}.jsonl`) : null;
};

/** Wire model id of every non-synthetic assistant turn, in order. */
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
    } catch { /* partial line mid-write */ }
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

/** Wait until a NEW assistant turn lands beyond `since` entries. Returns its model. */
async function waitForTurn(sessionId: string, since: number, timeoutMs = 120_000): Promise<string | null> {
  const got = await poll(() => {
    const models = assistantModels(sessionId);
    return models.length > since ? models : false;
  }, timeoutMs);
  return got ? got[got.length - 1] : null;
}

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

test.beforeAll(() => {
  reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-model-wizard'));
  for (let i = 0; i < 6; i++) {
    try { rmSync(PROJECT, { recursive: true, force: true }); break; } catch { /* held — retry */ }
  }
  mkdirSync(PROJECT, { recursive: true });
});

test.afterAll(async () => {
  // Archive through the app's own endpoint (kills process, flips to archived,
  // removes JSONL, prunes history), then a disk fallback for anything it missed.
  for (const id of createdSessions) {
    try {
      await fetch(
        `${BASE_URL}/api/session?sessionId=${encodeURIComponent(id)}&project=${encodeURIComponent(PROJECT)}`,
        { method: 'DELETE' },
      );
    } catch { /* server gone — disk fallback below */ }
  }
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

test('session-less GET /api/claude-sdk/model warms the catalog (regression: warmModels is not a function)', async ({ page }) => {
  // This is the EXACT call the wizard's model step makes. On a stale singleton
  // (SINGLETON_VERSION not bumped) it 500s with "warmModels is not a function".
  const res = await page.request.get('/api/claude-sdk/model');
  expect(res.ok(), 'session-less catalog GET must succeed — it 500s when the live singleton lacks warmModels').toBe(true);

  const data = await res.json();
  expect(Array.isArray(data.models), 'response has a models array').toBe(true);
  expect(data.models.length, 'catalog is non-empty (warmModels resolved a real list)').toBeGreaterThan(0);
  // No session yet → no override, no context.
  expect(data.live).toBe(false);
  expect(data.current).toBeUndefined();
  // The catalog is the provider's real one — Haiku is always present.
  const values = data.models.map((m: { value: string }) => m.value);
  expect(values, 'the warmed catalog includes Haiku').toContain('haiku');
});

test('New Session wizard: a model picked before the first prompt serves the first turn', async ({ page }) => {
  test.setTimeout(4 * 60 * 1000);

  // The wizard mints the session id client-side and records the model with a
  // POST /api/claude-sdk/model on "Create session". Capture that id — it's the
  // only place the test can learn which session the JSONL will be under.
  let sessionId: string | null = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/claude-sdk/model')) {
      try {
        const body = JSON.parse(req.postData() || '{}');
        if (body.sessionId) sessionId = body.sessionId;
      } catch { /* not the body we want */ }
    }
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // ---- Step (a): New Session → directory picker ----
  await page.getByRole('button', { name: 'New Session' }).click();
  const dirDialog = page.getByRole('dialog').filter({ hasText: 'Select Working Directory' });
  await expect(dirDialog, 'directory step opens').toBeVisible({ timeout: 15_000 });
  // Any valid directory advances the wizard; the send below pins cwd=PROJECT
  // explicitly, so the exact directory chosen here doesn't affect the outcome.
  const nextBtn = dirDialog.getByRole('button', { name: 'Next' });
  await expect(nextBtn, 'directory loaded (Next enabled)').toBeEnabled({ timeout: 15_000 });
  await nextBtn.click();

  // ---- Step (b): model step — this fetch is the warmModels path, via the UI ----
  const modelDialog = page.getByRole('dialog').filter({ hasText: 'Select model' });
  await expect(modelDialog, 'model step opens').toBeVisible({ timeout: 15_000 });
  await expect(
    modelDialog.locator('input[type="radio"]').first(),
    'the warmed catalog renders in the wizard (empty here = warmModels failed)',
  ).toBeVisible({ timeout: 20_000 });

  // Pick Haiku — cheapest and unambiguous against the Opus default.
  const haikuRow = modelDialog.locator('label').filter({ hasText: 'Haiku' }).first();
  await expect(haikuRow, 'catalog offers Haiku').toBeVisible();
  await haikuRow.locator('input[type="radio"]').check();
  await modelDialog.getByRole('button', { name: 'Create session' }).click();

  // ---- Lands in the composer for the new session ----
  await expect(page.getByTestId('send-button'), 'wizard completes into the composer').toBeVisible({ timeout: 20_000 });

  // The status-bar label reflects the wizard pick IMMEDIATELY — before the first
  // turn's session:model init event — so the user sees the model they chose, not
  // the provider default. (Regression guard for "update the model label after a
  // new session is created".)
  await expect(
    page.getByTestId('model-label'),
    'status-bar label reflects the wizard-picked model right after Create',
  ).toContainText(/Haiku/i, { timeout: 10_000 });

  // The Create step must have recorded the pending model with the new id.
  expect(sessionId, 'wizard POSTed a pending model with the client-minted session id').toBeTruthy();
  createdSessions.push(sessionId!);

  // Confirm the override round-trips before the first turn (pending, per-session).
  // The wizard pins the concrete version id the catalog offered (e.g.
  // claude-haiku-4-5-20251001), not the floating 'haiku' alias.
  const got = await (await page.request.get(`/api/claude-sdk/model?sessionId=${sessionId}`)).json();
  expect(got.current, 'the wizard-picked model is recorded as a concrete Haiku version override').toMatch(/^claude-haiku/);

  // ---- First prompt (via API for determinism, cwd pinned to PROJECT) ----
  // Sends stay on the API in this repo's e2e pattern (see build-calculator).
  // The model was chosen entirely through the wizard UI above; this only drives
  // the turn so the transcript can prove which model served it.
  const res = await page.request.post('/api/claude-sdk', {
    data: {
      prompt: 'Reply with exactly the word READY. Do not use any tools. No explanation.',
      sessionId,
      projectPath: PROJECT,
    },
  });
  expect(res.ok(), '/api/claude-sdk should accept the first turn').toBe(true);

  const served = await waitForTurn(sessionId!, 0);
  console.log(`[E2E] wizard first turn served by: ${served}`);
  expect(served, 'the first turn must be served by Haiku — the model picked in the wizard').toMatch(/haiku/i);
});
