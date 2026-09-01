import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  // Post-run cleanup of the ../fury-e2e-* scratch project dirs the specs create as
  // repo siblings (each spec recreates its own at start but never removes it).
  globalTeardown: './tests/global-teardown.ts',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3879',
    headless: false,
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3879',
    reuseExistingServer: true,
  },
});
