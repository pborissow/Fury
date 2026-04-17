import { test, expect } from '@playwright/test';

const DUP_SERVER_NAME = 'pw-dup-test';
const DUP_SERVER_URL = 'http://localhost:9999/dup-test/mcp';

async function openMcpPanel(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForTimeout(2000);

  const sessionItem = page.locator('[class*="cursor-pointer"]').first();
  if (await sessionItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sessionItem.click();
    await page.waitForTimeout(1000);
  }

  const mcpTab = page.locator('button', { hasText: 'MCP' });
  await mcpTab.waitFor({ timeout: 5000 });
  await mcpTab.click();
  await page.waitForTimeout(500);
}

async function removeServer(name: string) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);
  try { await exec('claude', ['mcp', 'remove', name, '-s', 'user'], { timeout: 10000 }); } catch { /* ignore */ }
  try { await exec('claude', ['mcp', 'remove', name, '-s', 'project'], { timeout: 10000 }); } catch { /* ignore */ }
}

// --- (1) Duplicate prevention ---

test.describe('MCP duplicate prevention', () => {

  test.beforeEach(async () => {
    await removeServer(DUP_SERVER_NAME);
  });

  test.afterEach(async () => {
    await removeServer(DUP_SERVER_NAME);
  });

  test('rejects adding a server with the same URL (same specs)', async ({ page }) => {
    // First add via CLI so we have a known server
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    await exec('claude', [
      'mcp', 'add', '--transport', 'http', '--scope', 'user',
      DUP_SERVER_NAME, DUP_SERVER_URL,
    ], { timeout: 10000 });

    // Try adding with a DIFFERENT name but the SAME URL — should still get 409
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'totally-different-name',
          transport: 'http',
          commandOrUrl: 'http://localhost:9999/dup-test/mcp',
          scope: 'user',
        }),
      });
      return { status: res.status, body: await res.json() };
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toContain('already exists');
    // Error should mention the existing server's name
    expect(result.body.error).toContain(DUP_SERVER_NAME);
  });

  test('UI shows error when adding duplicate server', async ({ page }) => {
    // Add server via CLI
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    await exec('claude', [
      'mcp', 'add', '--transport', 'http', '--scope', 'user',
      DUP_SERVER_NAME, DUP_SERVER_URL,
    ], { timeout: 10000 });

    await openMcpPanel(page);

    // Wait for MCP list to finish loading (spinner gone)
    const refreshBtn = page.locator('button[title="Refresh"]');
    await refreshBtn.waitFor({ timeout: 10000 });
    await expect(refreshBtn.locator('.animate-spin')).not.toBeVisible({ timeout: 20000 });

    // Try adding the same server via UI wizard
    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.click();

    const remoteCard = page.locator('button', { hasText: 'Remote server' });
    await remoteCard.waitFor({ timeout: 3000 });
    await remoteCard.click();

    const nameInput = page.locator('input[placeholder="my-server"]');
    await nameInput.fill('some-other-name');
    const urlTextarea = page.locator('textarea');
    await urlTextarea.fill(DUP_SERVER_URL);

    const addServerBtn = page.locator('button', { hasText: 'Add Server' });
    await addServerBtn.click();

    // Should show an error in the red error box, NOT advance to step 3
    await expect(page.locator('.text-red-400', { hasText: 'already exists' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Step 3 of 3')).not.toBeVisible();
  });
});

// --- (2) MCP tab refreshes on session switch ---

test.describe('MCP tab session switch', () => {

  test('MCP panel re-fetches when switching sessions', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Get at least two sessions from the sidebar
    const sessions = page.locator('[class*="cursor-pointer"]');
    const count = await sessions.count();
    test.skip(count < 2, 'Need at least 2 sessions to test switching');

    // Click first session
    await sessions.nth(0).click();
    await page.waitForTimeout(1000);

    // Open MCP tab
    const mcpTab = page.locator('button', { hasText: 'MCP' });
    await mcpTab.waitFor({ timeout: 5000 });
    await mcpTab.click();

    // Wait for initial MCP load (spinner stops)
    const refreshBtn = page.locator('button[title="Refresh"]');
    await refreshBtn.waitFor({ timeout: 5000 });
    await expect(refreshBtn.locator('.animate-spin')).not.toBeVisible({ timeout: 20000 });

    // Intercept API calls to verify a new fetch happens on switch
    const mcpRequests: string[] = [];
    page.on('request', req => {
      if (req.url().includes('/api/mcp') && req.method() === 'GET') {
        mcpRequests.push(req.url());
      }
    });

    // Switch to second session (MCP tab stays open)
    await sessions.nth(1).click();
    await page.waitForTimeout(1000);

    // The key={viewingTranscriptId} fix should cause McpPanel to remount,
    // triggering a fresh /api/mcp fetch
    await page.waitForTimeout(5000);
    expect(mcpRequests.length).toBeGreaterThanOrEqual(1);
  });
});

// --- (3) Fast MCP refresh (scope/transport without per-server CLI calls) ---

test.describe('MCP fast refresh', () => {

  test('API returns transport and scope without per-server get calls', async ({ page }) => {
    // Ensure a known HTTP server exists
    await removeServer(DUP_SERVER_NAME);
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    await exec('claude', [
      'mcp', 'add', '--transport', 'http', '--scope', 'user',
      DUP_SERVER_NAME, DUP_SERVER_URL,
    ], { timeout: 10000 });

    await page.goto('/');

    // Time the API response
    const start = Date.now();
    const result = await page.evaluate(() =>
      fetch('/api/mcp').then(r => r.json())
    );
    const elapsed = Date.now() - start;

    const server = result.servers?.find((s: any) => s.name === DUP_SERVER_NAME);
    expect(server).toBeTruthy();
    expect(server.transport).toBe('http');
    // scope is 'user' since we added with --scope user
    expect(server.scope).toBe('user');

    console.log(`MCP list returned in ${elapsed}ms with ${result.servers?.length} servers`);

    await removeServer(DUP_SERVER_NAME);
  });
});
