/**
 * Shared fixture + page helpers for the Search-tab e2e suite.
 *
 * FIXTURE SAFETY (same contract as delete-to-archive.spec.ts):
 * playwright.config.ts sets reuseExistingServer, so these specs run against
 * the developer's real server and real ~/.fury/fury.db. Each spec file seeds
 * its OWN pair of synthetic sessions (unique tag + timestamp) and teardown
 * hard-deletes exactly those session_ids. Project paths are synthetic /tmp
 * slugs, nothing is written to history.jsonl, and no pre-existing row is ever
 * touched.
 *
 * DETERMINISM: every searchable token embeds the per-run STAMP (`zq<stamp><tag>`),
 * so queries can never match the developer's real archive — including any
 * conversation where this very suite was discussed (constant tokens in this
 * file WOULD end up in the archive the moment such a session is archived).
 *
 * The pair:
 *  - Session A: ACTIVE, 4 marker messages (user/assistant alternating). Its
 *    first message repeats the marker 3× so A outranks B on relevance (bm25
 *    term frequency), while its updated_at sits 30 days back so Recent-sort
 *    flips the order. Active DB-only sessions surface in the Chat sidebar
 *    (loadArchivedSessions default), so A also backs the sidebar-reveal spec.
 *  - Session B: ARCHIVED, one long assistant message with a single marker.
 *    Archived rows are searchable but hidden from the sidebar — backing the
 *    "Include archived" filter, the archived badge, and the no-sidebar-card
 *    assertion.
 */
import { createClient, type Client } from '@libsql/client';
import { expect, type Page } from '@playwright/test';
import { furyDbPath } from '../../lib/furyHome';

// Mirrors getDbPath() in lib/db.ts — libSQL needs a file:// URL with forward
// slashes. furyDbPath() resolves the same file the running server uses.
const DB_URL = 'file:///' + furyDbPath().replace(/\\/g, '/');

export function createSearchFixture(tag: string) {
  const STAMP = Date.now();
  /** The only token the specs ever search for. */
  const MARKER = `zq${STAMP}${tag}`;
  const SESSION_A = `e2e-search-${tag}-a-${STAMP}`;
  const SESSION_B = `e2e-search-${tag}-b-${STAMP}`;
  const PROJECT_A = `/tmp/fury-e2e-search-${tag}-${STAMP}/alpha`;
  const PROJECT_B = `/tmp/fury-e2e-search-${tag}-${STAMP}/beta`;
  const DISPLAY_A = `E2E SEARCH FIXTURE A ${tag} ${STAMP}`;
  const DISPLAY_B = `E2E SEARCH FIXTURE B ${tag} ${STAMP}`;

  let db: Client;

  /** A's messages: 2 user + 2 assistant, every one a search hit. */
  const MESSAGES_A = [
    { role: 'user', content: `${MARKER} ${MARKER} ${MARKER} anchor question` },
    { role: 'assistant', content: `${MARKER} first reply` },
    { role: 'user', content: `${MARKER} follow-up question` },
    { role: 'assistant', content: `${MARKER} second reply` },
  ];
  // Long single-marker body: bm25's length normalization must not let B beat
  // A's tf=3 opener, or the relevance-order assertion gets flaky.
  const MESSAGE_B =
    `${MARKER} appears exactly once in this deliberately long archived reply, ` +
    'padded with enough neutral prose that its bm25 score stays safely below ' +
    'the triple-term opener of fixture session A under any length normalization.';

  /** Execute with SQLITE_BUSY retries: spec files run in parallel workers,
   *  all writing the one fury.db alongside the live server — brief write-lock
   *  collisions are expected, not fatal. */
  async function run(sql: string, args: (string | number)[] = []): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await db.execute({ sql, args });
        return;
      } catch (e) {
        if (attempt >= 6 || !/SQLITE_BUSY|locked/i.test(String(e))) throw e;
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }

  async function seed(): Promise<void> {
    db = createClient({ url: DB_URL });
    await run('PRAGMA busy_timeout = 10000');
    const now = Date.now();
    const oldTs = now - 30 * 86_400_000; // A: 30 days back — deep in the sidebar

    await run(
      `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, jsonl_hash, metadata, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [SESSION_A, PROJECT_A, DISPLAY_A, MESSAGES_A.length, oldTs, oldTs, `e2e-hash-a-${STAMP}`,
       JSON.stringify({ contextTokens: 10_000, contextWindow: 200_000 })],
    );
    for (const [i, m] of MESSAGES_A.entries()) {
      await run(
        'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
        [SESSION_A, m.role, m.content, new Date(oldTs + i * 60_000).toISOString(), i],
      );
    }

    await run(
      `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, jsonl_hash, metadata, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'archived')`,
      [SESSION_B, PROJECT_B, DISPLAY_B, 1, now, now, `e2e-hash-b-${STAMP}`,
       JSON.stringify({ contextTokens: 5_000, contextWindow: 200_000 })],
    );
    await run(
      'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
      [SESSION_B, 'assistant', MESSAGE_B, new Date(now).toISOString(), 0],
    );
  }

  /** Hard-delete both fixtures; belt-and-braces child cleanup like the
   *  archive spec (don't leak rows into the developer's Stats/Search). */
  async function teardown(): Promise<void> {
    for (const id of [SESSION_A, SESSION_B]) {
      await run('DELETE FROM sessions WHERE session_id = ?', [id]);
      for (const t of ['messages', 'raw_jsonl', 'usage_events']) {
        await run(`DELETE FROM ${t} WHERE session_id = ?`, [id]);
      }
    }
    db.close();
  }

  return {
    MARKER, SESSION_A, SESSION_B, PROJECT_A, PROJECT_B, DISPLAY_A, DISPLAY_B,
    MESSAGES_A, MESSAGE_B, seed, teardown,
  };
}

/** The primary tab strip — scoped via Canvas, which appears nowhere else
 *  (same trick as delete-to-archive.spec.ts). */
function tabBar(page: Page) {
  return page.locator('div.border-b.border-border').filter({
    has: page.getByRole('button', { name: 'Canvas', exact: true }),
  }).first();
}

/** Desktop: open the Search tab, retrying across the ui-state restore race
 *  (page.tsx restores activeTab from /api/ui-state on mount, which can revert
 *  an early click). The search input is visibility-hidden with its panel, so
 *  its visibility IS the "tab took" signal. */
export async function openSearchTab(page: Page): Promise<void> {
  await page.goto('/');
  await expect(async () => {
    await tabBar(page).getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Desktop: switch back to the Chat tab (used by the open-session spec). */
export async function openChatTab(page: Page): Promise<void> {
  await expect(async () => {
    await tabBar(page).getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByTestId('search-input')).not.toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Phone: tabs live in the hamburger drawer, not a tab strip. */
export async function openSearchTabMobile(page: Page): Promise<void> {
  await page.goto('/');
  await expect(async () => {
    await page.getByTestId('mobile-menu-button').click();
    await page.getByTestId('mobile-drawer').getByText('Search', { exact: true }).click({ timeout: 2_000 });
    await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Reset every filter to its default. Search prefs (role/archived/sort AND
 *  the query) persist globally in state.json, so a parallel spec file — or an
 *  earlier test that failed before its own cleanup — can poison the restored
 *  state of this page load. Prefs are only READ at mount, so normalizing
 *  in-page makes each test independent of whatever any other run persisted.
 *  Filters only render with a query — call after one is set. */
async function normalizeFilters(page: Page): Promise<boolean> {
  let changed = false;
  const all = page.getByTestId('search-role-toggle').getByRole('button', { name: 'All' });
  if ((await all.getAttribute('aria-pressed')) !== 'true') { await all.click(); changed = true; }
  const archived = page.getByTestId('search-archived-toggle');
  if ((await archived.getAttribute('aria-pressed')) === 'false') { await archived.click(); changed = true; }
  const relevance = page.getByRole('button', { name: 'Relevance', exact: true });
  if ((await relevance.getAttribute('aria-pressed')) !== 'true') { await relevance.click(); changed = true; }
  const project = page.locator('select[aria-label="Project"]');
  if (await project.count()) {
    if ((await project.inputValue()) !== 'all') { await project.selectOption('all'); changed = true; }
  }
  return changed;
}

/** The search re-fetch is DEBOUNCED (~200ms): right after a keystroke or a
 *  filter click, the PREVIOUS results — count line included — are still on
 *  screen, so "count visible" alone can pass before the re-search even
 *  starts, and its late response then resets expansion/selection state under
 *  the test. Wait out the debounce tail first, then wait for the count
 *  (hidden while loading) to come back. */
async function settleSearch(page: Page): Promise<void> {
  await page.waitForTimeout(450);
  await expect(page.getByTestId('search-result-count')).toBeVisible({ timeout: 10_000 });
}

/** Type a query, normalize the filters (see normalizeFilters), and wait for
 *  the results to settle. `fill` replaces any restored/persisted query. */
export async function searchFor(page: Page, query: string): Promise<void> {
  await page.getByTestId('search-input').fill(query);
  await settleSearch(page);
  if (await normalizeFilters(page)) await settleSearch(page);
}

/** Clear the query so the persisted search prefs (state.json restores the
 *  query across reloads) don't leave fixture markers in the developer's
 *  next real session. Call at the end of each spec file. */
export async function clearQuery(page: Page): Promise<void> {
  await page.getByTestId('search-input').fill('');
  await page.waitForTimeout(400); // let the debounced prefs persist fire
}
