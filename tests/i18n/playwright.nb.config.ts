/**
 * Playwright config for the Norwegian playthrough (tests/i18n/e2e). Its own dev server on port 5192
 * so it never collides with other suites. Run: xvfb-run -a npx playwright test -c tests/i18n/playwright.nb.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 180000,
  use: {
    baseURL: 'http://localhost:5192',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    locale: 'nb-NO',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --port 5192 --strictPort',
    cwd: '../..',
    port: 5192,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
