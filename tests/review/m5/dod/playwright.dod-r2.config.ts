/**
 * M5 DoD audit (review round 2): own Vite dev server on port 5324.
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/dod/playwright.dod.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 1800000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5324',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --port 5324 --strictPort',
    cwd: '../../../..',
    port: 5324,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
