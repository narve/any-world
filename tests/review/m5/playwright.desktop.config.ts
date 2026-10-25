import { defineConfig } from '@playwright/test';

/** Desktop playtester (M5 review): headed chromium under xvfb at 1280x800 against a dev server on 5311. */
export default defineConfig({
  testDir: '.',
  testMatch: /pt-desktop.*\.spec\.ts$/,
  timeout: 900000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5311',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5311 ANYWORLD_API_PORT=5312 npx vite --port 5311 --strictPort',
    port: 5311,
    reuseExistingServer: true,
    timeout: 60000,
    cwd: '../../..',
  },
});
