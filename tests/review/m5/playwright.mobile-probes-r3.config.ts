/**
 * M5 mobile playtest (review round 3): its own Vite dev server on port 5332 so it never collides with
 * other suites. HMR is off (vite.pt-r3.config.ts).
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.mobile-pt-r3.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /mobile-probes-r3\.spec\.ts$/,
  timeout: 900000,
  workers: 2,
  fullyParallel: true,
  // its own output folder: the default test-results/ is shared with (and wiped by) other suites
  outputDir: '../../../test-results/m5-mobile-probes-r3',
  use: {
    baseURL: 'http://localhost:5332',
    channel: 'chromium',
    headless: false,
    actionTimeout: 10000,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --config tests/review/m5/vite.pt-r3.config.ts --port 5332 --strictPort',
    cwd: '../../..',
    port: 5332,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
