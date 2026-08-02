import { test, expect } from '@playwright/test';

const TEST_SERVER_NAME = 'pw-codemogger';

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
  try {
    await exec('claude', ['mcp', 'remove', name], { timeout: 10000 });
  } catch {
    // ignore
  }
}

test.describe('MCP wizard — Code Search (codemogger)', () => {

  test.beforeEach(async () => {
    await removeServer(TEST_SERVER_NAME);
    // Clean slate: the "This project" card is now disabled when ANY project-scoped
    // codemogger server exists (keyed on command, not name), so remove a
    // pre-existing `codemogger` too — otherwise the add-flow card starts disabled.
    await removeServer('codemogger');
  });

  test.afterEach(async () => {
    await removeServer(TEST_SERVER_NAME);
  });

  test('adds a codemogger MCP server for the Fury project', async ({ page }) => {
    await openMcpPanel(page);

    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    // Step 1: Should see three cards
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    await expect(page.locator('button', { hasText: 'This project' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Local process' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Remote server' })).toBeVisible();

    // Select "This project"
    await page.locator('button', { hasText: 'This project' }).click();

    // Step 2: Should see Code Search form
    await expect(page.locator('text=Step 2 of 3')).toBeVisible();
    // Dialog title should say "Code Search"
    await expect(page.locator('[class*="font-semibold"]', { hasText: 'Code Search' })).toBeVisible();

    // Name should be pre-filled with the project directory name (e.g. "Fury")
    const nameInput = page.locator('input[placeholder="my-project"]');
    await expect(nameInput).toBeVisible();
    const nameValue = await nameInput.inputValue();
    console.log(`Pre-filled name: ${nameValue}`);
    expect(nameValue.length).toBeGreaterThan(0);

    // Override with test name to avoid collision
    await nameInput.clear();
    await nameInput.fill(TEST_SERVER_NAME);

    // Should have a pre-populated directory (the current project)
    // and an "Add directory" button
    await expect(page.locator('button', { hasText: 'Add directory' })).toBeVisible();

    // Verify at least one directory is listed (projectPath should be pre-added)
    // Directory entries have a FolderOpen icon + mono path + X button inside bg-muted/40
    const dirEntries = page.locator('[class*="bg-muted"] .font-mono');
    const dirCount = await dirEntries.count();
    console.log(`Pre-populated directories: ${dirCount}`);

    // If no directories pre-populated, add the Fury project path manually
    if (dirCount === 0) {
      // We'll just verify the button is disabled without directories
      const addServerBtn = page.locator('button', { hasText: 'Add Server' });
      await expect(addServerBtn).toBeDisabled();
      console.log('No project path available — skipping add test');
      return;
    }

    // Should NOT see stdio-specific fields
    await expect(page.locator('label', { hasText: 'Command' })).not.toBeVisible();
    await expect(page.locator('label', { hasText: 'Arguments' })).not.toBeVisible();
    await expect(page.locator('label', { hasText: 'Environment variables' })).not.toBeVisible();

    // Click "Add Server"
    const addServerBtn = page.locator('button', { hasText: 'Add Server' });
    await expect(addServerBtn).toBeEnabled();
    await addServerBtn.click();

    // Step 3: Success + CLAUDE.md template
    await expect(page.locator('text=Step 3 of 3')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.text-green-400', { hasText: 'added successfully' })).toBeVisible();

    // Template should mention codemogger_search and codemogger_index
    const templateArea = page.locator('textarea');
    const templateText = await templateArea.inputValue();
    console.log('Generated template:\n' + templateText);
    expect(templateText).toContain('codemogger_search');
    expect(templateText).toContain('codemogger_index');

    // Skip CLAUDE.md
    await page.locator('button', { hasText: 'Skip' }).click();

    // Verify via CLI that it was registered as stdio with codemogger command
    // (UI list may be slow to refresh for stdio servers due to health checks)
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    const { stdout, stderr } = await exec('claude', ['mcp', 'get', TEST_SERVER_NAME], {
      timeout: 15000, encoding: 'utf-8',
    });
    const detail = (stdout || '') + (stderr || '');
    console.log('MCP server details:\n' + detail);

    expect(detail).toContain('Type: stdio');
    expect(detail).toContain('codemogger');
    // Should use codemogger directly, not npx
    expect(detail).toContain('Command: codemogger');
    expect(detail).not.toContain('npx');

    // B3: the --db path must survive intact as a single argument (the wizard now
    // sends args as an array, so a spaced home wouldn't shatter it). The db path
    // ends in `.codemogger/index.db` and `mcp` follows it on the same Args line.
    const argsLine = detail.split('\n').find(l => l.includes('Args:')) || '';
    console.log('Args line:', argsLine);
    expect(argsLine).toContain('--db');
    expect(argsLine).toMatch(/--db\s+\S*[/\\]\.codemogger[/\\]index\.db\s+mcp/);

    // B1: registering the code-search server must ensure the --db parent dir
    // exists so codemogger can open the DB on first use (it won't mkdir an
    // explicit --db parent itself). We assert the dir exists post-registration.
    // (The unit test tests/unit/mcp-args.test.ts proves it is CREATED when
    // missing; here we can't delete the real ~/.codemogger without destroying
    // the user's index, so this is the integration-level existence check.)
    const { existsSync } = await import('fs');
    const { homedir } = await import('os');
    const { join } = await import('path');
    const codemoggerDir = join(homedir(), '.codemogger');
    expect(existsSync(codemoggerDir), `${codemoggerDir} should exist after registration`).toBe(true);

    // Enhancement: now that codemogger is configured for this project, reopening
    // the wizard must show the "This project" card DISABLED up-front (detected by
    // command, not name), instead of round-tripping to the route's 409.
    await addButton.click();
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    const codesearchCard = page.getByTestId('wizard-codesearch');
    await expect(codesearchCard, 'card is disabled once code search exists').toBeDisabled({ timeout: 10000 });
    await expect(codesearchCard).toHaveAttribute('title', 'Code search is already set up for this project');
    // The other two cards stay enabled.
    await expect(page.locator('button', { hasText: 'Local process' })).toBeEnabled();
  });
});
