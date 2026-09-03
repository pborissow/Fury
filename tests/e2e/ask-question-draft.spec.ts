/**
 * The AskUserQuestion dialog is only modal within the chat panel — the session
 * list stays clickable, and switching sessions UNMOUNTS the dialog (ChatTab
 * clears askUserQuestion unconditionally on switch, then re-parks the question
 * on switch-back). The shipped dialog kept all form state in its own useState,
 * so a switch-away/switch-back cycle silently discarded every selection and
 * typed "Other" answer.
 *
 * Fixed by the module-level draft store in components/AskUserQuestionDialog.tsx
 * (askDrafts): drafts are keyed by question identity, restored on mount, and
 * deleted on submit/skip.
 *
 * Reproduced against the real dialog in /app/dialog-harness/ask — mount/unmount
 * buttons stand in for the session switch, no live Claude turn required.
 */
import { test, expect } from '@playwright/test';

test('in-progress answers survive a session-switch unmount/remount', async ({ page }) => {
  await page.goto('/dialog-harness/ask');
  const dialog = page.locator('[data-dialog-header]');
  await expect(dialog).toBeVisible();

  // Radios in order: Option A, Option B, Other.
  const radios = page.locator('input[name="question-0"]');

  // Pick "Other" and type a custom answer.
  await page.getByText('Other', { exact: true }).click();
  const editor = page.getByTestId('harness-panel').locator('[contenteditable="true"]');
  await editor.click();
  await editor.pressSequentially('my custom answer that must survive');
  // The editor reports changes debounced (debounceMs=150) — let it flush.
  await page.waitForTimeout(400);

  // Simulate the session switch: unmount, then remount.
  await page.getByTestId('switch-away').click();
  await expect(dialog).not.toBeAttached();
  await page.getByTestId('switch-back').click();
  await expect(dialog).toBeVisible();

  // Draft restored: "Other" still selected, text intact, Submit enabled.
  await expect(radios.nth(2)).toBeChecked();
  await expect(
    page.getByTestId('harness-panel').locator('[contenteditable="true"]'),
  ).toContainText('my custom answer that must survive');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();

  // A plain radio selection survives another cycle too.
  await radios.nth(0).check();
  await page.getByTestId('switch-away').click();
  await expect(dialog).not.toBeAttached();
  await page.getByTestId('switch-back').click();
  await expect(radios.nth(0)).toBeChecked();
});

test('skip clears the draft — remount starts fresh', async ({ page }) => {
  await page.goto('/dialog-harness/ask');
  const dialog = page.locator('[data-dialog-header]');
  await expect(dialog).toBeVisible();
  const radios = page.locator('input[name="question-0"]');

  await radios.nth(0).check();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByTestId('last-result')).toHaveText('skipped');

  // In the real app onSkip unmounts the dialog; the harness simulates that
  // with the switch buttons.
  await page.getByTestId('switch-away').click();
  await expect(dialog).not.toBeAttached();
  await page.getByTestId('switch-back').click();
  await expect(dialog).toBeVisible();

  // Resolved questions must not resurrect their draft.
  await expect(radios.nth(0)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
});
