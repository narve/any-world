/**
 * M5 mobile playtest (review round 2): its own Vite dev server on port 5322 so it never collides with
 * other suites. HMR is off (vite.pt-r2.config.ts).
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.mobile-pt-r2.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /mobile-playtest-r2\.spec\.ts$/,
  timeout: 900000,
  workers: 2,
  fullyParallel: true,
  // its own output folder: the default test-results/ is shared with (and wiped by) other suites
  outputDir: '../../../test-results/m5-mobile-pt-r2',
  use: {
    baseURL: 'http://localhost:5322',
    channel: 'chromium',
    headless: false,
    actionTimeout: 10000,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --config tests/review/m5/vite.pt-r2.config.ts --port 5322 --strictPort',
    cwd: '../../..',
    port: 5322,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
