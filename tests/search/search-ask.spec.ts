/**
 * Ask mode in the Search tab (docs/ticket-ask-search.md §5, §7).
 *
 * MOCK BOUNDARY: POST /api/search/ask is intercepted in the browser, as the
 * ticket specifies (a real Haiku call is nondeterministic and costs tokens).
 * The route's own protocol + fallbacks are unit-tested in
 * tests/unit/ask-route.test.ts; the agent is evaluated live by hand. The
 * canned answers point at this spec's REAL seeded fixture sessions, so the
 * card → Chat deep link is exercised for real.
 *
 * Pins: keyword vs question routing (typing never calls the agent; Enter asks
 * only for question-shaped input; the Ask button works for any input),
 * progress + cancel, answer cards with the agent's "why" and working deep
 * links, the prose and keyword-fallback panels, double-Enter dedupe, and
 * leaving ask mode on edit.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { createSearchFixture, openSearchTab } from './fixture';

const fx = createSearchFixture('ask');

test.beforeAll(async () => { await fx.seed(); });
test.afterAll(async () => { await fx.teardown(); });

const QUESTION = `where did we discuss the ${fx.MARKER} follow-up question?`;
const ndjson = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function answerEvent(extra: object = {}) {
  return {
    type: 'answer',
    summary: `Session A discussed ${fx.MARKER} in a follow-up question.`,
    results: [{
      sessionId: fx.SESSION_A, turnIndex: 2,
      hit: { role: 'user', timestamp: new Date().toISOString(), excerpt: `${fx.MARKER} follow-up question` },
      why: 'The user asked the follow-up question here.',
      title: fx.DISPLAY_A, project: fx.PROJECT_A, status: 'active', updatedAt: Date.now(), messageCount: 4,
    }],
    dropped: 1, costUsd: 0.002, durationMs: 4200,
    ...extra,
  };
}

/** Intercept the ask route; returns a counter of requests and their bodies. */
async function mockAsk(page: Page, respond: (route: Route) => Promise<void>) {
  const calls: string[] = [];
  await page.route('**/api/search/ask', async (route) => {
    calls.push(JSON.parse(route.request().postData() || '{}').question);
    await respond(route);
  });
  return calls;
}

const fulfill = (route: Route, body: string) =>
  route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });

test.describe('Search tab: Ask mode', () => {
  test('typing never calls the agent; the hint appears only for question-shaped input', async ({ page }) => {
    const calls = await mockAsk(page, (r) => fulfill(r, ndjson(answerEvent())));
    await openSearchTab(page);
    const input = page.getByTestId('search-input');

    await input.fill(fx.MARKER);                                   // keyword
    await page.waitForTimeout(500);
    await expect(page.getByTestId('ask-hint')).toHaveCount(0);
    await expect(page.getByTestId('ask-button')).toBeVisible();

    await input.pressSequentially(' where did we discuss it?', { delay: 15 }); // now a question
    await expect(page.getByTestId('ask-hint')).toBeVisible();
    await page.waitForTimeout(500);                                // debounce passes
    expect(calls).toEqual([]);                                     // typing alone: no model call
    await expect(page.getByTestId('search-result-count')).toBeVisible(); // keyword search still ran
  });

  test('Enter asks: progress, then a summary and cards that deep-link into Chat', async ({ page }) => {
    const calls = await mockAsk(page, async (r) => {
      await new Promise((res) => setTimeout(res, 1200));           // agent "working"
      await fulfill(r, ndjson(
        { type: 'progress', tool: 'list_projects', input: {} },
        { type: 'progress', tool: 'search_transcripts', input: { q: fx.MARKER } },
        answerEvent(),
      ));
    });
    await openSearchTab(page);
    await page.getByTestId('search-input').fill(QUESTION);
    await page.getByTestId('search-input').press('Enter');

    await expect(page.getByTestId('ask-progress')).toBeVisible();
    await expect(page.getByTestId('ask-cancel')).toBeVisible();
    await expect(page.getByTestId('ask-summary-text')).toHaveText(answerEvent().summary, { timeout: 10_000 });
    await expect(page.getByTestId('ask-dropped')).toContainText('1 suggested session');
    expect(calls).toEqual([QUESTION]);

    // Ask mode replaces keyword UI: no filter rail, no keyword count line.
    await expect(page.getByTestId('search-archived-toggle')).toHaveCount(0);
    await expect(page.getByTestId('search-result-count')).toHaveCount(0);

    const card = page.getByTestId('search-result-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(fx.DISPLAY_A);
    await expect(card.getByTestId('ask-why')).toHaveText('The user asked the follow-up question here.');

    // The cited message opens in Chat, scrolled to it.
    await card.getByTestId('search-hit').click();
    await expect(page.getByTestId('search-input')).not.toBeVisible();
    const bubble = page.locator('[data-msg-index]').filter({ hasText: `${fx.MARKER} follow-up question` }).first();
    await expect(bubble).toBeVisible({ timeout: 10_000 });
    await expect(bubble).toBeInViewport();
  });

  test('a double Enter sends one request; Cancel aborts and returns to keyword results', async ({ page }) => {
    let aborted = false;
    const calls = await mockAsk(page, async (r) => {
      await new Promise((res) => setTimeout(res, 4000));
      try { await fulfill(r, ndjson(answerEvent())); } catch { aborted = true; }
    });
    page.on('requestfailed', (req) => { if (req.url().includes('/api/search/ask')) aborted = true; });
    await openSearchTab(page);
    const input = page.getByTestId('search-input');
    await input.fill(QUESTION);
    await input.press('Enter');
    await input.press('Enter');
    await expect(page.getByTestId('ask-progress')).toBeVisible();
    await expect(page.getByTestId('ask-button')).toBeDisabled();
    await page.getByTestId('ask-cancel').click();

    await expect(page.getByTestId('ask-progress')).toHaveCount(0);
    await expect(page.getByTestId('search-result-count')).toBeVisible();
    expect(calls).toHaveLength(1);
    await expect.poll(() => aborted, { timeout: 6_000 }).toBe(true);
  });

  test('editing the query while the agent works cancels the running ask', async ({ page }) => {
    let aborted = false;
    await mockAsk(page, async (r) => {
      await new Promise((res) => setTimeout(res, 4000));
      try { await fulfill(r, ndjson(answerEvent())); } catch { aborted = true; }
    });
    page.on('requestfailed', (req) => { if (req.url().includes('/api/search/ask')) aborted = true; });
    await openSearchTab(page);
    const input = page.getByTestId('search-input');
    await input.fill(QUESTION);
    await input.press('Enter');
    await expect(page.getByTestId('ask-progress')).toBeVisible();
    await input.press('End');
    await input.type(' and the second reply');   // the user refines instead of waiting
    await expect(page.getByTestId('ask-progress')).toHaveCount(0);
    // The superseded request is aborted (server-side that interrupts the agent),
    // not left running to spend tokens on a question nobody is waiting for.
    await expect.poll(() => aborted, { timeout: 6_000 }).toBe(true);
  });

  test('the Ask button works for keyword-shaped input; editing the query leaves ask mode', async ({ page }) => {
    const calls = await mockAsk(page, (r) => fulfill(r, ndjson(answerEvent())));
    await openSearchTab(page);
    const input = page.getByTestId('search-input');
    await input.fill(fx.MARKER);
    await input.press('Enter');                                    // keyword Enter: no ask
    await page.waitForTimeout(300);
    expect(calls).toEqual([]);

    await page.getByTestId('ask-button').click();
    await expect(page.getByTestId('ask-summary')).toBeVisible();
    expect(calls).toEqual([fx.MARKER]);

    await input.press('End');
    await input.type(' x');
    await expect(page.getByTestId('ask-summary')).toHaveCount(0);
    await expect(page.getByTestId('search-archived-toggle')).toBeVisible(); // keyword UI back
  });

  test('falls back to labeled keyword results, or the agent\'s prose', async ({ page }) => {
    let mode: 'fallback' | 'prose' = 'fallback';
    await mockAsk(page, (r) => fulfill(r, mode === 'fallback'
      ? ndjson({
          type: 'fallback', reason: 'timeout', message: 'Ask exceeded 30000 ms', query: fx.MARKER, project: null,
          totalHits: 1,
          results: [{
            sessionId: fx.SESSION_A, project: fx.PROJECT_A, display: fx.DISPLAY_A, status: 'active', messageCount: 4,
            updatedAt: Date.now(), titleMatch: false, hitCount: 1,
            hits: [{ role: 'user', turnIndex: 0, timestamp: new Date().toISOString(), snippet: `\u0001${fx.MARKER}\u0002 anchor`, rank: -1 }],
          }],
        })
      : ndjson({ type: 'prose', text: 'I think it was session A, around the follow-up.' })));
    await openSearchTab(page);
    const input = page.getByTestId('search-input');

    await input.fill(QUESTION);
    await input.press('Enter');
    await expect(page.getByTestId('ask-fallback')).toContainText('keyword fallback');
    await expect(page.getByTestId('ask-fallback')).toContainText('took too long');
    await expect(page.getByTestId('search-result-card')).toHaveCount(1);
    await expect(page.getByTestId('ask-why')).toHaveCount(0);        // no agent notes on fallback cards

    mode = 'prose';
    await input.fill(`${QUESTION} again?`);
    await input.press('Enter');
    await expect(page.getByTestId('ask-prose')).toContainText('I think it was session A');
    await expect(page.getByTestId('search-result-card')).toHaveCount(0);
  });

  test('shows a length counter near the limit and refuses to ask past it', async ({ page }) => {
    const calls = await mockAsk(page, (r) => fulfill(r, ndjson(answerEvent())));
    await openSearchTab(page);
    const long = `where did we talk about ${'the file tree and '.repeat(30)}watchers?`;
    await page.getByTestId('search-input').fill(long);
    await expect(page.getByTestId('ask-char-count')).toContainText('/500');
    await expect(page.getByTestId('ask-button')).toBeDisabled();
    await page.getByTestId('search-input').press('Enter');
    await page.waitForTimeout(300);
    expect(calls).toEqual([]);
  });
});
