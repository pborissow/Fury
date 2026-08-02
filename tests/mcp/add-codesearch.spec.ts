/**
 * "This project" code-search wizard — UI flow (docs/ticket-codesearch-inprocess-mcp-
 * macos-contention.md). Code search is now enabled IN-PROCESS via POST /api/code-search
 * (no stdio MCP server is registered), and the panel surfaces it as a synthetic
 * `codeSearch` entry that disables the wizard card.
 *
 * This drives the wizard UI and asserts the flow WITHOUT actually indexing the real
 * repo: the code-search + MCP-list APIs are stubbed at the network layer, so no
 * embedder loads and nothing is written to disk. The real enable→index→search
 * integration is covered by the live specs (mcp-codesearch / mcp-per-project-db /
 * mcp-autorefresh-e2e) against scratch projects.
 */
import { test, expect, type Page } from '@playwright/test';

async function openMcpPanel(page: Page) {
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

test.describe('MCP wizard — Code Search (in-process)', () => {
  test('enables in-process code search and disables the wizard card', async ({ page }) => {
    // Stub the code-search + MCP-list APIs so the wizard flow runs without loading the
    // embedder or indexing the real repo. `enabled` flips on the POST so the panel's
    // subsequent MCP-list fetch surfaces the synthetic code-search entry.
    let enabled = false;
    await page.route('**/api/code-search', async (route) => {
      if (route.request().method() === 'POST') {
        enabled = true;
        await route.fulfill({ json: { success: true, enabled: true, dirs: ['/tmp/proj'], removedStdio: [] } });
      } else {
        await route.fulfill({ json: { enabled, dirs: enabled ? ['/tmp/proj'] : [], dbExists: enabled } });
      }
    });
    await page.route(/\/api\/mcp(\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const servers = enabled
        ? [{
            name: 'codemogger', url: 'in-process code search · 1 dir', status: 'connected',
            statusDetail: 'In-process (Fury) — no separate process', scope: 'project',
            transport: 'stdio', codeSearch: true, dirs: ['/tmp/proj'],
          }]
        : [];
      await route.fulfill({ json: { servers } });
    });

    await openMcpPanel(page);

    const addButton = page.locator('button[title="Add MCP server"]');
    await addButton.waitFor({ timeout: 5000 });
    await addButton.click();

    // Step 1: three cards.
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    await expect(page.locator('button', { hasText: 'This project' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Local process' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Remote server' })).toBeVisible();

    // Select "This project" → Step 2: Project MCP form.
    await page.locator('button', { hasText: 'This project' }).click();
    await expect(page.locator('text=Step 2 of 3')).toBeVisible();
    await expect(page.locator('[class*="font-semibold"]', { hasText: 'Project MCP' })).toBeVisible();

    // Should have a pre-populated directory (the current project) + "Add directory".
    await expect(page.locator('button', { hasText: 'Add directory' })).toBeVisible();
    const dirEntries = page.locator('[class*="bg-muted"] .font-mono');
    const dirCount = await dirEntries.count();
    console.log(`Pre-populated directories: ${dirCount}`);
    if (dirCount === 0) {
      // No project path available — the add button must be disabled; nothing to test.
      await expect(page.locator('button', { hasText: 'Add Server' })).toBeDisabled();
      console.log('No project path available — skipping add test');
      return;
    }

    // Code search is NOT stdio/http — no command/args/env fields.
    await expect(page.locator('label', { hasText: 'Command' })).not.toBeVisible();
    await expect(page.locator('label', { hasText: 'Arguments' })).not.toBeVisible();
    await expect(page.locator('label', { hasText: 'Environment variables' })).not.toBeVisible();

    // Add Server → Step 3: success + CLAUDE.md template.
    const addServerBtn = page.locator('button', { hasText: 'Add Server' });
    await expect(addServerBtn).toBeEnabled();
    await addServerBtn.click();

    await expect(page.locator('text=Step 3 of 3')).toBeVisible({ timeout: 15000 });
    const templateArea = page.locator('textarea');
    const templateText = await templateArea.inputValue();
    console.log('Generated template:\n' + templateText);
    expect(templateText).toContain('codemogger_search');
    expect(templateText).toContain('codemogger_index');

    // Skip CLAUDE.md.
    await page.locator('button', { hasText: 'Skip' }).click();

    // Now that code search is enabled (in-process, synthetic entry), reopening the
    // wizard shows the "This project" card DISABLED up-front.
    await addButton.click();
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();
    const codesearchCard = page.getByTestId('wizard-codesearch');
    await expect(codesearchCard, 'card is disabled once code search exists').toBeDisabled({ timeout: 10000 });
    await expect(codesearchCard).toHaveAttribute('title', 'Code search is already set up for this project');
    // The other two cards stay enabled.
    await expect(page.locator('button', { hasText: 'Local process' })).toBeEnabled();
  });
});
