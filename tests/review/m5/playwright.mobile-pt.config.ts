/**
 * M5 mobile playtest (review round 1): its own Vite dev server on port 5312 so it never collides with
 * other suites. Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.mobile-pt.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /mobile-playtest\.spec\.ts$/,
  timeout: 900000,
  workers: 2,
  // its own output folder: the default test-results/ is shared with (and wiped by) other suites
  outputDir: '../../../test-results/m5-mobile-pt',
  use: {
    baseURL: 'http://localhost:5312',
    channel: 'chromium',
    headless: false,
    actionTimeout: 10000,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --port 5312 --strictPort',
    cwd: '../../..',
    port: 5312,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
