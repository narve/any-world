import { defineConfig } from '@playwright/test';

/**
 * Norwegian (bokmål) reviewer (M5 review round 2): headed chromium under xvfb, nb-NO locale, its own dev
 * server on 5323. Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.nb-r2.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /nb-review-r2.*\.spec\.ts$/,
  timeout: 600000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5323',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    locale: 'nb-NO',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5323 ANYWORLD_API_PORT=5324 npx vite --port 5323 --strictPort',
    port: 5323,
    reuseExistingServer: true,
    timeout: 60000,
    cwd: '../../..',
  },
});
