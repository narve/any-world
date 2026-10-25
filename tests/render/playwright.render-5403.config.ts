import { defineConfig } from '@playwright/test';

/**
 * Same as playwright.render.config.ts but on the renderer fixer's own ports (5403 / 5404), so it can run
 * next to other agents' dev servers:
 *   xvfb-run -a npx playwright test -c tests/render/playwright.render-5403.config.ts e2e/render-phone-panels.spec.ts
 */
export default defineConfig({
  testDir: '../../e2e',
  testMatch: /render-.*\.spec\.ts$/,
  timeout: 600000,
  workers: 1,
  outputDir: '../../test-results/render-5403',
  use: {
    baseURL: 'http://localhost:5403',
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'ANYWORLD_CLIENT_PORT=5403 ANYWORLD_API_PORT=5404 npx vite --port 5403 --strictPort',
    port: 5403,
    reuseExistingServer: true,
    timeout: 60000,
    cwd: '../..',
  },
});
