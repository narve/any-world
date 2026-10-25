/**
 * M5 DoD audit (review round 3): own Vite dev server on port 5334.
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/dod/playwright.dod.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 1800000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5334',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --port 5334 --strictPort',
    cwd: '../../../..',
    port: 5334,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
