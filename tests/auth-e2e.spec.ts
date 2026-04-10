import { test, expect } from '@playwright/test';

const USERNAME = 'admin';
const PASSWORD = 'admin';

test('fury: full login → app → logout flow', async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': '192.168.1.100' },
  });
  const page = await context.newPage();

  // Step 1: Navigate → redirected to /login
  await page.goto('http://localhost:3879/');
  await page.waitForURL('**/login');
  await expect(page.locator('text=Sign in to continue')).toBeVisible({ timeout: 5000 });
  console.log('PASS: redirected to login, form visible');

  // Step 2: Login with valid credentials
  await page.locator('input[name="fury-login-user"]').fill(USERNAME);
  await page.locator('input[name="fury-login-pass"]').fill(PASSWORD);
  await page.locator('button:has-text("Sign in")').click();

  // Should redirect to main app
  await page.waitForURL('http://localhost:3879/', { timeout: 10000 });
  console.log('PASS: logged in, redirected to /');

  // Step 3: User icon should be visible in toolbar
  const userButton = page.locator('button[title="' + USERNAME + '"]');
  await expect(userButton).toBeVisible({ timeout: 5000 });
  console.log('PASS: user icon visible');

  // Step 4: Click user icon → dropdown with Sign out
  await userButton.click();
  await expect(page.locator('text=Sign out')).toBeVisible({ timeout: 2000 });
  console.log('PASS: user menu dropdown visible');

  // Step 5: Click Sign out → redirected to /login
  await page.locator('text=Sign out').click();
  await page.waitForURL('**/login', { timeout: 10000 });
  await expect(page.locator('text=Sign in to continue')).toBeVisible({ timeout: 5000 });
  console.log('PASS: logged out, back to login');

  await context.close();
});
