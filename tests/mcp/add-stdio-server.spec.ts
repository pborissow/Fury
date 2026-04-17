import { test, expect } from '@playwright/test';

const TEST_SERVER_NAME = 'pw-test-stdio';
const TEST_COMMAND = 'echo';
const TEST_ARGS = 'pw-stdio-placeholder';

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

async function removeServer(name: string, cwd?: string) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);
  try {
    await exec('claude', ['mcp', 'remove', name, '-s', 'project'], {
      timeout: 10000,
      ...(cwd ? { cwd } : {}),
    });
  } catch {
    // ignore — may not exist
  }
}

test.describe('MCP wizard — add stdio server', () => {

  test.beforeEach(async () => {
    await removeServer(TEST_SERVER_NAME, 'C:\\Users\\petya\\Documents\\Javascript\\Fury');
  });

  test.afterEach(async () => {
    await removeServer(TEST_SERVER_NAME, 'C:\\Users\\petya\\Documents\\Javascript\\Fury');
  });

  test('adds a stdio MCP server with args and project scope', async ({ page }) => {
    await openMcpPanel(page);

    // Click + to open wizard
    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    // Step 1: Select "Local process" (stdio)
    const localCard = page.locator('button', { hasText: 'Local process' });
    await localCard.waitFor({ timeout: 3000 });
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    await localCard.click();

    // Step 2: Fill in details
    await expect(page.locator('text=Step 2 of 3')).toBeVisible();

    // Verify stdio-specific fields are visible
    await expect(page.locator('label', { hasText: 'Name' })).toBeVisible();
    await expect(page.locator('label', { hasText: 'Command' })).toBeVisible();
    await expect(page.locator('label', { hasText: 'Arguments' })).toBeVisible();
    await expect(page.locator('label', { hasText: 'Environment variables' })).toBeVisible();
    await expect(page.locator('label', { hasText: 'Scope' })).toBeVisible();

    // Fill form
    const nameInput = page.locator('input[placeholder="my-server"]');
    await nameInput.fill(TEST_SERVER_NAME);

    const commandInput = page.locator('input[placeholder="npx my-mcp-server"]');
    await commandInput.fill(TEST_COMMAND);

    const argsInput = page.locator('input[placeholder="--port 3000"]');
    await argsInput.fill(TEST_ARGS);

    // Set scope to project (should be default)
    const scopeSelect = page.locator('select');
    await scopeSelect.selectOption('project');

    // Intercept the API call to see what's sent and returned
    const apiPromise = page.waitForResponse(
      (response) => response.url().includes('/api/mcp') && response.request().method() === 'POST'
    );

    // Click "Add Server"
    const addServerButton = page.locator('button', { hasText: 'Add Server' });
    await expect(addServerButton).toBeEnabled();
    await addServerButton.click();

    // Capture the API response
    const apiResponse = await apiPromise;
    const requestBody = apiResponse.request().postDataJSON();
    const responseBody = await apiResponse.json();

    console.log('=== REQUEST BODY ===');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('=== RESPONSE STATUS ===', apiResponse.status());
    console.log('=== RESPONSE BODY ===');
    console.log(JSON.stringify(responseBody, null, 2));

    // Check if we got to step 3 (success) or stayed on step 2 (error)
    const step3 = page.locator('text=Step 3 of 3');
    const errorBox = page.locator('.text-red-400');

    const gotStep3 = await step3.isVisible({ timeout: 10000 }).catch(() => false);
    if (!gotStep3) {
      const errorText = await errorBox.textContent().catch(() => 'no error text found');
      console.log('=== DID NOT REACH STEP 3 ===');
      console.log('Error displayed:', errorText);
    } else {
      console.log('=== REACHED STEP 3 (success) ===');
      const successMsg = page.locator('.text-green-400');
      if (await successMsg.isVisible().catch(() => false)) {
        console.log('Success message:', await successMsg.textContent());
      }
    }

    // Step 3: Should show success
    await expect(page.locator('text=Step 3 of 3')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.text-green-400', { hasText: 'added successfully' })).toBeVisible();

    // Skip CLAUDE.md
    await page.locator('button', { hasText: 'Skip' }).click();

    // Verify the server appears in the MCP list
    await page.waitForTimeout(2000);
    await expect(page.locator(`text=${TEST_SERVER_NAME}`).first()).toBeVisible({ timeout: 10000 });

    // Verify via API that it parses correctly
    const result = await page.evaluate((projPath) =>
      fetch(`/api/mcp?projectPath=${encodeURIComponent(projPath)}`).then(r => r.json()),
      'C:\\Users\\petya\\Documents\\Javascript\\Fury'
    );

    const server = result.servers?.find((s: any) => s.name === TEST_SERVER_NAME);
    console.log('=== API RESULT ===');
    console.log(JSON.stringify(server, null, 2));
    expect(server).toBeTruthy();
    expect(server.transport).toBe('stdio');
  });
});
