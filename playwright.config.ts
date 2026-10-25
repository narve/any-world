import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    // WebGL only works in headed Chromium in this sandbox: run under xvfb (`npm run e2e` does this).
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  // The API server and the Vite dev server (which proxies /api to it) in one process, as `npm run dev`
  // does. Vite alone made every /api call fail with 502 unless a dev server was already running.
  webServer: {
    command: 'npx tsx server/dev.ts',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60000,
    env: { PORT: '8787', ANYWORLD_CLIENT_PORT: '5173' },
  },
});
