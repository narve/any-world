/**
 * M5 DoD audit (review round 1): own Vite dev server on port 5314.
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/dod/playwright.dod.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 1800000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5314',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --port 5314 --strictPort',
    cwd: '../../../..',
    port: 5314,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
