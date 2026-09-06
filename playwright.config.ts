import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { chromium, defineConfig } from '@playwright/test';

const hasBundledChromium = (() => {
  try {
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return false;
    // Walk up to the versioned dir (…/ms-playwright/chromium-<rev>) that holds
    // the marker.
    let dir = dirname(exe);
    while (dir !== dirname(dir) && !basename(dir).startsWith('chromium-')) dir = dirname(dir);
    return existsSync(join(dir, 'INSTALLATION_COMPLETE'));
  } catch {
    return false;
  }
})();

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  globalTeardown: './tests/global-teardown.ts',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3879',
    headless: false,
    viewport: { width: 1400, height: 900 },
    ...(hasBundledChromium ? {} : { channel: 'chrome' as const }),
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3879',
    reuseExistingServer: true,
  },
});
