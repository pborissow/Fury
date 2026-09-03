/**
 * Delete → Archive: deleting a session must soft-delete it, not annihilate it.
 *
 * Guards the three traps from docs/delete-to-archive.md:
 *   1. Re-surfacing — an archived session (row kept, JSONL deleted) is exactly
 *      the shape /api/history's DB-merge exists to surface. Without the
 *      status filter in loadArchivedSessions it reappears on the next history
 *      refresh and archiving is a visual no-op. Hence: assert gone, refresh,
 *      assert STILL gone. The refresh is the whole test.
 *   2. Resurrection — archiveTranscript's ON CONFLICT must never write status.
 *   3. The lying dialog — the confirm copy must not claim permanence.
 * ...plus the headline guard: Stats totals must not move when a session is
 * archived. That regression is the reason the ticket exists.
 *
 * FIXTURE SAFETY: playwright.config.ts sets reuseExistingServer, so this runs
 * against the developer's real server and real ~/.claude/fury.db. Every
 * assertion here targets ONE synthetic seeded session, and teardown hard-deletes
 * exactly that session_id. No pre-existing session is ever archived, and the
 * fixture's project path is synthetic so no real JSONL can be unlinked. The
 * fixture is deliberately NOT written to history.jsonl — the archive route
 * rewrites that file, and a fixture has no business touching the user's real
 * history.
 */
import { test, expect, type Page } from '@playwright/test';
import { createClient, type Client } from '@libsql/client';
import { furyDbPath } from '../../lib/furyHome';

// Mirrors getDbPath() in lib/db.ts — libSQL needs a file:// URL with forward
// slashes. furyDbPath() resolves the same file the running server uses
// (~/.fury/fury.db, legacy-aware).
const DB_URL = 'file:///' + furyDbPath().replace(/\\/g, '/');

const STAMP = Date.now();
// Sanitized to [a-zA-Z0-9-] so it survives the delete route's path-traversal
// scrub unchanged (route.ts strips everything else, and a mangled id would
// silently target a different row).
const SESSION_ID = `e2e-archive-fixture-${STAMP}`;
const DISPLAY = `E2E ARCHIVE FIXTURE ${STAMP} — safe to delete`;
// Synthetic path: nothing on disk maps to its slug, so the route's unlink is a
// guaranteed ENOENT no-op rather than a real file deletion.
const PROJECT = `/tmp/fury-e2e-archive-fixture-${STAMP}`;

const MODEL = 'claude-opus-4-8';
const USAGE = [
  { messageId: `${SESSION_ID}-msg-1`, input: 1_000, output: 2_000, cacheWrite: 3_000, cacheRead: 4_000 },
  { messageId: `${SESSION_ID}-msg-2`, input: 5_000, output: 6_000, cacheWrite: 7_000, cacheRead: 8_000 },
];

let db: Client;

async function seed(): Promise<void> {
  const now = Date.now();
  const iso = new Date(now).toISOString();

  await db.execute({
    sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, jsonl_hash, metadata, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    args: [SESSION_ID, PROJECT, DISPLAY, 2, now, now, `e2e-hash-${STAMP}`,
           JSON.stringify({ contextTokens: 12_000, contextWindow: 200_000, hasUsageEvents: true })],
  });

  for (const [i, m] of [
    { role: 'user', content: DISPLAY },
    { role: 'assistant', content: 'Fixture reply.' },
  ].entries()) {
    await db.execute({
      sql: 'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
      args: [SESSION_ID, m.role, m.content, iso, i],
    });
  }

  for (const [i, line] of [
    JSON.stringify({ type: 'user', message: { role: 'user', content: DISPLAY } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Fixture reply.' } }),
  ].entries()) {
    await db.execute({
      sql: 'INSERT INTO raw_jsonl (session_id, line_number, content) VALUES (?, ?, ?)',
      args: [SESSION_ID, i, line],
    });
  }

  for (const u of USAGE) {
    await db.execute({
      sql: `INSERT INTO usage_events (session_id, message_id, model, ts, input, output, cache_write, cache_write_5m, cache_write_1h, cache_read, context_window, is_sidechain)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 200000, 0)`,
      args: [SESSION_ID, u.messageId, MODEL, iso, u.input, u.output, u.cacheWrite, u.cacheWrite, u.cacheRead],
    });
  }
}

/** Hard-delete the fixture. FK cascade clears its children. */
async function teardown(): Promise<void> {
  await db.execute({ sql: 'DELETE FROM sessions WHERE session_id = ?', args: [SESSION_ID] });
  // Belt and braces: if the cascade is ever off, don't leak fixture rows into
  // the developer's Stats.
  for (const t of ['usage_events', 'raw_jsonl', 'messages']) {
    await db.execute({ sql: `DELETE FROM ${t} WHERE session_id = ?`, args: [SESSION_ID] });
  }
}

async function childCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['usage_events', 'raw_jsonl', 'messages']) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`,
      args: [SESSION_ID],
    });
    out[t] = Number(r.rows[0].n);
  }
  return out;
}

/** The sidebar card for the fixture. Scoped to the session card, not the page. */
function sessionCard(page: Page) {
  return page.locator('div[class*="group/session"]').filter({ hasText: DISPLAY });
}

/** The primary tab strip — scoped via Canvas, which appears nowhere else, so
 *  "Chat"/"Sessions" elsewhere in the app can't hijack these locators. */
function tabBar(page: Page) {
  return page.locator('div.border-b.border-border').filter({
    has: page.getByRole('button', { name: 'Canvas', exact: true }),
  }).first();
}

/** Switch tabs and assert the switch actually took — page.tsx restores
 *  activeTab from /api/ui-state on mount, which races an early click and
 *  silently reverts it. Retry until the underline indicator confirms it stuck. */
async function openTab(page: Page, tab: 'Chat' | 'Stats'): Promise<void> {
  const button = tabBar(page).getByRole('button', { name: tab, exact: true });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await button.click();
    // The active tab is the only one carrying the underline span.
    await expect(button.locator('span.bg-primary')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Read a KPI tile's value by its label.
 *
 * Targets the StatTile label element specifically (its exact class trio) and
 * takes the immediately-following sibling, which is the value. A looser text
 * match is not safe here: "Sessions" is also the sessions-table heading and
 * ChatTab's sidebar <h2>, and tabs are mounted-and-CSS-hidden, so the Chat DOM
 * is present and matchable even while Stats is showing.
 */
async function readKpi(page: Page, label: string): Promise<string> {
  const tile = page
    .locator('div.text-xs.font-medium.text-muted-foreground')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  return (await tile.locator('xpath=following-sibling::div[1]').innerText()).trim();
}

async function readKpis(page: Page): Promise<Record<string, string>> {
  return {
    spend: await readKpi(page, 'Estimated spend'),
    tokens: await readKpi(page, 'Total tokens'),
    sessions: await readKpi(page, 'Sessions'),
  };
}

test.describe.serial('delete → archive', () => {
  test.beforeAll(async () => {
    db = createClient({ url: DB_URL });
    await teardown(); // paranoia: clear any residue from a crashed prior run
    await seed();
  });

  test.afterAll(async () => {
    await teardown();
    db.close();
  });

  test('archiving preserves the session everywhere except the sidebar', async ({ page }) => {
    test.setTimeout(120_000);

    // Never networkidle: the app holds SSE streams open, so the network never
    // idles and goto times out.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await openTab(page, 'Chat');
    await expect(sessionCard(page)).toBeVisible({ timeout: 30_000 });

    const before = await childCounts();
    expect(before).toEqual({ usage_events: 2, raw_jsonl: 2, messages: 2 });

    // ---- Case 2 (baseline): Stats KPIs before the archive ----
    let baseline: Record<string, string> = {};
    await test.step('Stats counts the session before archiving', async () => {
      await openTab(page, 'Stats');
      baseline = await readKpis(page);
      // The fixture must actually be in the totals, or "unchanged after" is vacuous.
      await expect(
        page.locator('table').getByText(DISPLAY, { exact: false })
      ).toBeVisible({ timeout: 15_000 });
      await openTab(page, 'Chat');
    });

    // ---- Case 4: UI wording (trap #3) ----
    await test.step('context menu and confirm dialog say Archive, and the copy is honest', async () => {
      await sessionCard(page).first().click({ button: 'right' });

      // Scope to the context-menu popover. Every non-live session card also
      // renders an inline hover button titled "Archive session", and role-name
      // matching is a case-insensitive substring, so an unscoped locator matches
      // all of those too (strict-mode violation). The popover is the only
      // `fixed z-50 bg-popover` element on the page while the menu is open.
      const contextMenu = page.locator('div.fixed.z-50.bg-popover');
      const menuItem = contextMenu.getByRole('button', { name: 'Archive Session' });
      await expect(menuItem).toBeVisible();
      // The icon swap: lucide renders the component name into the class list.
      await expect(menuItem.locator('svg.lucide-archive')).toBeVisible();
      await menuItem.click();

      const dialog = page.getByRole('dialog').filter({ hasText: 'Archive session?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();

      // Trap #3: the old copy claimed permanent, irreversible deletion. Both
      // clauses are now false — shipping them would tell the user the opposite
      // of what the feature does.
      const copy = (await dialog.innerText()).toLowerCase();
      expect(copy).not.toContain('permanently');
      expect(copy).not.toContain('cannot be undone');
      expect(copy).toContain('kept');
    });

    // ---- Case 1: archive hides it, and it STAYS hidden (trap #1) ----
    await test.step('archiving removes it from the sidebar and it stays gone after a refresh', async () => {
      await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
      await expect(sessionCard(page)).toHaveCount(0, { timeout: 30_000 });

      // The load-bearing half. An unfiltered loadArchivedSessions re-surfaces the
      // session here — row kept + JSONL gone is precisely what the DB-merge
      // hunts for — and the naive "it disappeared" check above passes anyway.
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await openTab(page, 'Chat');
      // Wait for the sidebar to actually populate before asserting absence,
      // otherwise an empty list trivially "passes".
      await expect(page.locator('div[class*="group/session"]').first()).toBeVisible({ timeout: 30_000 });
      await expect(sessionCard(page)).toHaveCount(0);
    });

    // ---- Case 2: the headline guard — Stats must not move ----
    await test.step('Stats totals are identical after archiving', async () => {
      await openTab(page, 'Stats');
      // Poll: the tab refetches on focus, so the first paint may still be the
      // pre-archive render.
      await expect(async () => {
        expect(await readKpis(page)).toEqual(baseline);
      }).toPass({ timeout: 20_000 });
    });

    // ---- Case 3: nothing was destroyed ----
    await test.step('the row survives as archived with every child row intact', async () => {
      const row = await db.execute({
        sql: 'SELECT status, display, message_count FROM sessions WHERE session_id = ?',
        args: [SESSION_ID],
      });
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].status).toBe('archived');
      expect(row.rows[0].display).toBe(DISPLAY);
      // Nothing cascaded — this is what keeps Stats honest.
      expect(await childCounts()).toEqual(before);
    });

    // Trap #2 (a re-archive must not resurrect an archived session) is covered
    // in tests/unit/archive-status.test.ts. It belongs there, not here: driving
    // archiveTranscript from this process would import lib/db and fire getDb's
    // startup scan against the developer's real ~/.claude/fury.db from a second
    // process. The unit test runs the same code against a throwaway DB.
  });
});
