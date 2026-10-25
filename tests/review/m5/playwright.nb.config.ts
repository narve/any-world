import { defineConfig } from '@playwright/test';

/**
 * Norwegian (bokmål) reviewer (M5 review): headed chromium under xvfb, nb-NO locale, its own dev
 * server on 5313. Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.nb.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /nb-review-r1.*\.spec\.ts$/,
  timeout: 600000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5313',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    locale: 'nb-NO',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5313 ANYWORLD_API_PORT=5314 npx vite --port 5313 --strictPort',
    port: 5313,
    reuseExistingServer: true,
    timeout: 60000,
    cwd: '../../..',
  },
});
