import { defineConfig } from '@playwright/test';

/** M5 round 3 client fixer: e2e/m5-client-fixes-r3.spec.ts against a private dev server on 5400. */
export default defineConfig({
  testDir: '../../../e2e',
  testMatch: /m5-client-fixes-r3\.spec\.ts$/,
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5400',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5400 PORT=5401 npx vite --port 5400 --strictPort',
    port: 5400,
    reuseExistingServer: false,
    timeout: 90000,
    cwd: '../../..',
  },
});
