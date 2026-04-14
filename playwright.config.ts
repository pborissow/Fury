import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
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
