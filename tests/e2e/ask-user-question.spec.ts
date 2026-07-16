/**
 * End-to-end: Claude asks a question, WAITS for the human, and the answer lands
 * in the SAME turn — the whole point of routing AskUserQuestion through
 * canUseTool instead of the CLI's kill + prose + re-prompt hack.
 *
 * Two things this asserts that nothing else can:
 *
 *  1. ONE TURN. The old path killed the process and re-injected the answer as a
 *     brand-new user prompt. So "the answer arrived" is NOT enough — the
 *     transcript must contain exactly one user text message (the original
 *     prompt). A second one means the hack came back.
 *
 *  2. TRAP #4: navigating away from an ANSWERED session must not re-open the
 *     dialog. transcriptParser's pending-question flag is permanently stuck-on
 *     for SDK sessions (its only clear sits behind `typeof content === 'string'`
 *     and our answer arrives as an array-content tool_result), so if ChatTab ever
 *     stops ignoring it, every visit re-opens an answered question forever.
 *     This test is the only thing that catches that.
 *
 * Drives the UI for the dialog (that's the surface under test) and the API for
 * the send, following tests/e2e/build-calculator.spec.ts.
 *
 * COST/TIME: runs real Claude turns. Budget a few minutes.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findSessionJsonlDir } from '../../lib/sessionPaths';

// A sibling of the repo, per build-calculator's note about cwd/repo-root resolution.
const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-ask');

const jsonlPath = (sessionId: string): string | null => {
  const loc = findSessionJsonlDir(sessionId, PROJECT);
  return loc ? join(loc.dir, `${sessionId}.jsonl`) : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROMPT =
  'Use the AskUserQuestion tool right now to ask me whether I prefer tabs or spaces ' +
  'for indentation. Offer exactly two options: "Tabs" and "Spaces". After I answer, ' +
  'reply with exactly one word: the answer I chose. Do not use any other tool.';

/** Every user-role entry whose content is a plain string — i.e. a real typed turn. */
function userTextMessages(sessionId: string): string[] {
  const p = jsonlPath(sessionId);
  if (!p || !existsSync(p)) return [];
  const out: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      // A tool_result is also user-role, but its content is an ARRAY. Only a
      // string content is a prompt someone actually sent.
      if (e.type === 'user' && typeof e.message?.content === 'string') out.push(e.message.content);
    } catch { /* skip */ }
  }
  return out;
}

let createdSessionId: string | null = null;
const BASE_URL = 'http://localhost:3879';

test.afterAll(async () => {
  if (!createdSessionId) return;
  try {
    await fetch(
      `${BASE_URL}/api/session?sessionId=${encodeURIComponent(createdSessionId)}&project=${encodeURIComponent(PROJECT)}`,
      { method: 'DELETE' },
    );
  } catch { /* server down — disk fallback below */ }
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
});

test('Claude parks on a question, the answer lands in the same turn, and it never re-opens', async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);

  const sessionId = randomUUID();
  createdSessionId = sessionId;

  mkdirSync(PROJECT, { recursive: true });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  console.log(`[E2E] session=${sessionId}`);

  const res = await page.request.post('/api/claude-sdk', {
    data: { prompt: PROMPT, sessionId, projectPath: PROJECT },
  });
  expect(res.ok(), '/api/claude-sdk should accept').toBe(true);

  // Open the session so the dialog renders.
  const row = page.locator('.group\\/session').filter({ hasText: 'Use the AskUserQuestion tool' }).first();
  await expect(row, 'session should appear in the sidebar').toBeVisible({ timeout: 30_000 });
  await row.click();

  // ---- The dialog opens off the SDK's askUserQuestion event (with a toolUseID) ----
  const dialog = page.getByRole('dialog').filter({ hasText: 'Claude has a question' });
  await expect(dialog, 'the question dialog should open').toBeVisible({ timeout: 120_000 });
  await expect(dialog).toContainText(/tabs or spaces/i);

  // ---- TRAP #3: parked reads as "waiting for you", not a thinking spinner ----
  // isProcessing is legitimately true here (the turn is live, the process warm),
  // so without a distinct state the dots would spin for as long as the human
  // takes and read as a hang.
  //
  // The dialog opens off SSE the moment the tool fires, which can beat
  // fetchTranscript — and the message list (where the indicator lives) is
  // replaced by a "Loading transcript..." skeleton until that resolves. Wait it
  // out, or this races the panel rather than testing the state.
  await expect(page.getByText('Loading transcript...'), 'transcript should finish loading').toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('awaiting-answer'), 'parked should say it waits on the user').toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('processing-dots'), 'thinking dots must not spin while parked').toHaveCount(0);

  // ---- The server holds it: a refresh must NOT strand the turn ----
  const parked = await (await page.request.get(`/api/stream-buffer?sessionId=${sessionId}`)).json();
  expect(parked.pendingAsk?.toolUseID, 'stream-buffer must forward pendingAsk (the whitelist drops unknown fields)').toBeTruthy();

  // ---- A send while parked must be REJECTED, not silently swallowed ----
  // /api/claude dispatches sendMessage fire-and-forget, so the manager's own
  // guard can only reach a server-side console line while the client is told
  // {ok:true} — spinner forever, message gone. The route has to answer this one
  // itself. 409 is what ChatTab renders as an error and clears the spinner on.
  const blocked = await page.request.post('/api/claude', {
    data: { prompt: 'ping while parked', sessionId, projectPath: PROJECT },
  });
  expect(blocked.status(), 'a send while parked must be rejected with a real status').toBe(409);
  expect((await blocked.json()).error, 'and a message the user can act on').toMatch(/waiting for an answer/i);

  console.log('[E2E] reloading mid-park — the dialog must come back from server state');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const rowAfterReload = page.locator('.group\\/session').filter({ hasText: 'Use the AskUserQuestion tool' }).first();
  await rowAfterReload.click();
  const dialogAfterReload = page.getByRole('dialog').filter({ hasText: 'Claude has a question' });
  await expect(dialogAfterReload, 'a refresh must re-open the dialog — Claude is still waiting').toBeVisible({ timeout: 30_000 });

  // ---- Let it sit. Nothing may time out or kill the turn. ----
  await sleep(8000);
  await expect(dialogAfterReload, 'the question must survive a human thinking').toBeVisible();

  // ---- Answer "Spaces" through the real UI ----
  console.log('[E2E] answering: Spaces');
  await dialogAfterReload.getByText('Spaces', { exact: true }).click();
  await dialogAfterReload.getByRole('button', { name: 'Submit' }).click();
  await expect(dialogAfterReload, 'dialog should close on submit').toHaveCount(0, { timeout: 10_000 });

  // ---- The SAME turn continues and the model honors the answer ----
  await expect(page.getByTestId('send-button'), 'the turn should complete').toBeVisible({ timeout: 120_000 });

  const transcript = await (
    await page.request.get(`/api/transcript?sessionId=${sessionId}&project=${encodeURIComponent(PROJECT)}`)
  ).json();
  const assistantText = (transcript.messages ?? [])
    .filter((m: any) => m.role === 'assistant')
    .map((m: any) => m.content)
    .join('\n');
  console.log(`[E2E] final assistant text: ${JSON.stringify(assistantText.slice(-120))}`);
  expect(assistantText, 'the model should echo the answer we chose').toMatch(/spaces/i);

  // ---- HEADLINE: one turn. No kill, no re-prompt. ----
  const prompts = userTextMessages(sessionId);
  console.log(`[E2E] user text messages in JSONL: ${JSON.stringify(prompts)}`);
  expect(
    prompts.length,
    'exactly ONE user turn — a second means the answer was re-injected as a new prompt (the old hack)',
  ).toBe(1);
  expect(prompts[0]).toContain('AskUserQuestion');
  // The prose serializer must not have run on this path.
  expect(prompts.join('\n'), 'the prose answer must not appear as a prompt').not.toMatch(/I choose:/);

  // ---- TRAP #4 REGRESSION: navigate away and back — no haunting ----
  // transcriptParser still reports pendingAskUserQuestion for this session (its
  // clear can't see an array-content tool_result), so this passes ONLY because
  // ChatTab ignores that field on the SDK path.
  console.log('[E2E] TRAP #4: navigating away and back');
  const tr = await (
    await page.request.get(`/api/transcript?sessionId=${sessionId}&project=${encodeURIComponent(PROJECT)}`)
  ).json();
  console.log(`[E2E] parser still says pendingAskUserQuestion? ${!!tr.pendingAskUserQuestion} (expected: true)`);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const rowAgain = page.locator('.group\\/session').filter({ hasText: 'Use the AskUserQuestion tool' }).first();
  await expect(rowAgain).toBeVisible({ timeout: 30_000 });
  await rowAgain.click();
  await expect(page.getByTestId('send-button'), 'session should open').toBeVisible({ timeout: 30_000 });

  // Give it room to (wrongly) pop.
  await sleep(3000);
  await expect(
    page.getByRole('dialog').filter({ hasText: 'Claude has a question' }),
    'an ANSWERED question must not re-open on navigation (TRAP #4)',
  ).toHaveCount(0);
});
