import { defineConfig } from '@playwright/test';

/** Code review round 2 (M5): headed chromium under xvfb against a private dev server on 5341. */
export default defineConfig({
  testDir: '.',
  testMatch: /r2-code.*\.spec\.ts$/,
  timeout: 180000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5341',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5341 PORT=5342 npx vite --port 5341 --strictPort',
    port: 5341,
    reuseExistingServer: false,
    timeout: 90000,
    cwd: '../../..',
  },
});
