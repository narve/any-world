import { defineConfig } from '@playwright/test';

/**
 * Renderer e2e specs (e2e/render-*.spec.ts) against their own dev server on 5401, so they can run while
 * other dev servers (5173, …) are up. Headed chromium under xvfb:
 *   xvfb-run -a npx playwright test -c tests/render/playwright.render.config.ts [e2e/render-m5.spec.ts]
 */
export default defineConfig({
  testDir: '../../e2e',
  testMatch: /render-.*\.spec\.ts$/,
  timeout: 600000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5401',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5401 ANYWORLD_API_PORT=5402 npx vite --port 5401 --strictPort',
    port: 5401,
    reuseExistingServer: true,
    timeout: 60000,
    cwd: '../..',
  },
});
