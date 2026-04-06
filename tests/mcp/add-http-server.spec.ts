import { test, expect } from '@playwright/test';

const TEST_SERVER_NAME = 'playwright-test-http';
const TEST_SERVER_URL = 'http://localhost:9999/';

const MULTI_URLS = [
  'http://localhost:9999/pw-test-alpha/mcp',
  'http://localhost:9999/pw-test-beta/mcp',
];
const MULTI_NAMES = ['pw-test-alpha', 'pw-test-beta'];

async function openMcpPanel(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForTimeout(2000);

  // Click the first session in the sidebar to open the right panel
  const sessionItem = page.locator('[class*="cursor-pointer"]').first();
  if (await sessionItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sessionItem.click();
    await page.waitForTimeout(1000);
  }

  // Click the MCP tab button
  const mcpTab = page.locator('button', { hasText: 'MCP' });
  await mcpTab.waitFor({ timeout: 5000 });
  await mcpTab.click();
  await page.waitForTimeout(500);
}

async function removeServer(name: string) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);
  try {
    await exec('claude', ['mcp', 'remove', name], { timeout: 10000 });
  } catch {
    // ignore
  }
}

test.describe('MCP wizard — add HTTP server', () => {

  test.beforeEach(async () => {
    await removeServer(TEST_SERVER_NAME);
    for (const name of MULTI_NAMES) {
      await removeServer(name);
    }
  });

  test.afterEach(async () => {
    await removeServer(TEST_SERVER_NAME);
    for (const name of MULTI_NAMES) {
      await removeServer(name);
    }
  });

  test('adds an HTTP MCP server and shows it in the list', async ({ page }) => {
    await openMcpPanel(page);

    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    // Step 1: Select "Remote server"
    const remoteCard = page.locator('button', { hasText: 'Remote server' });
    await remoteCard.waitFor({ timeout: 3000 });
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    await remoteCard.click();

    // Step 2: Fill in details (single URL — name field should be visible)
    await expect(page.locator('text=Step 2 of 3')).toBeVisible();
    await expect(page.locator('label', { hasText: 'Arguments' })).not.toBeVisible();
    await expect(page.locator('label', { hasText: 'Environment variables' })).not.toBeVisible();

    const nameInput = page.locator('input[placeholder="my-server"]');
    await nameInput.fill(TEST_SERVER_NAME);

    const urlTextarea = page.locator('textarea');
    await urlTextarea.fill(TEST_SERVER_URL);

    const addServerButton = page.locator('button', { hasText: 'Add Server' });
    await addServerButton.click();

    // Step 3: Success
    await expect(page.locator('text=Step 3 of 3')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.text-green-400', { hasText: 'added successfully' })).toBeVisible();

    // Skip CLAUDE.md
    await page.locator('button', { hasText: 'Skip' }).click();

    // Verify in list
    await page.waitForTimeout(2000);
    await expect(page.locator(`text=${TEST_SERVER_NAME}`).first()).toBeVisible({ timeout: 10000 });
  });

  test('adds multiple HTTP servers from pasted URLs', async ({ page }) => {
    await openMcpPanel(page);

    // Refresh to pick up beforeEach cleanup and wait for the spinner to stop
    const refreshButton = page.locator('button[title="Refresh"]');
    await refreshButton.click();
    await expect(refreshButton.locator('.animate-spin')).not.toBeVisible({ timeout: 20000 });

    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    // Step 1: Remote
    const remoteCard = page.locator('button', { hasText: 'Remote server' });
    await remoteCard.waitFor({ timeout: 3000 });
    await remoteCard.click();

    // Step 2: Paste multiple URLs
    await expect(page.locator('text=Step 2 of 3')).toBeVisible();
    const urlTextarea = page.locator('textarea');
    await urlTextarea.fill(MULTI_URLS.join('\n'));

    // Name field should be hidden when multiple URLs are entered
    await expect(page.locator('input[placeholder="my-server"]')).not.toBeVisible();

    // Preview should show derived names
    await expect(page.locator('text=2 servers will be added').first()).toBeVisible();
    for (const name of MULTI_NAMES) {
      await expect(page.locator(`text=${name}`).first()).toBeVisible();
    }

    // Button should say "Add 2 Servers"
    const addButton2 = page.locator('button', { hasText: 'Add 2 Servers' });
    await expect(addButton2).toBeVisible();
    await addButton2.click();

    // Step 3: Success
    await expect(page.locator('text=Step 3 of 3')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.text-green-400', { hasText: 'added successfully' })).toBeVisible();

    // Skip CLAUDE.md
    await page.locator('button', { hasText: 'Skip' }).click();

    // Verify both appear in the list
    await page.waitForTimeout(3000);
    for (const name of MULTI_NAMES) {
      await expect(page.locator(`text=${name}`).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('back button returns to type selection', async ({ page }) => {
    await openMcpPanel(page);

    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    const remoteCard = page.locator('button', { hasText: 'Remote server' });
    await remoteCard.waitFor({ timeout: 3000 });
    await remoteCard.click();

    await expect(page.locator('text=Step 2 of 3')).toBeVisible();
    await page.locator('button', { hasText: 'Back' }).click();

    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Local process' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Remote server' })).toBeVisible();
  });

  test('local process shows args and env fields', async ({ page }) => {
    await openMcpPanel(page);

    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    const localCard = page.locator('button', { hasText: 'Local process' });
    await localCard.waitFor({ timeout: 3000 });
    await localCard.click();

    await expect(page.locator('text=Step 2 of 3')).toBeVisible();
    await expect(page.locator('label', { hasText: 'Arguments' })).toBeVisible();
    await expect(page.locator('label', { hasText: 'Environment variables' })).toBeVisible();
    await expect(page.locator('label', { hasText: 'Command' })).toBeVisible();
  });

  test('API parses HTTP servers from claude mcp list', async ({ page }) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);

    try {
      await exec('claude', [
        'mcp', 'add', '--transport', 'http', '--scope', 'user',
        TEST_SERVER_NAME, TEST_SERVER_URL,
      ], { timeout: 10000 });
    } catch (err) {
      console.log('Failed to add test server via CLI:', err);
      test.skip();
      return;
    }

    await page.goto('/');
    const result = await page.evaluate(() =>
      fetch('/api/mcp').then(r => r.json())
    );

    const server = result.servers?.find((s: any) => s.name === TEST_SERVER_NAME);
    expect(server).toBeTruthy();
    expect(server.url).toContain('localhost:9999');
    console.log('Parsed server:', JSON.stringify(server));
  });
});
