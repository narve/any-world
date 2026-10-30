/**
 * MP3 gate: the static (GitHub Pages) build with and without ANYWORLD_SERVER_URL. The gate builds
 * dist/static, serves it on STATIC_PORT (5197) with a plain file server and, for the server build,
 * runs server/index.ts on 8798 with ALLOWED_ORIGINS set; the spec reads STATIC_CASE (none | up | down).
 * Run: STATIC_CASE=… xvfb-run -a npx playwright test -c tests/review/mp3/playwright.static.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /static\.spec\.ts$/,
  timeout: 120_000,
  workers: 1,
  // its own output folder: the default test-results/ is shared with (and wiped by) other suites
  outputDir: '../../../test-results/mp3-gate-static',
  use: {
    baseURL: `http://127.0.0.1:${Number(process.env.STATIC_PORT) || 5197}`,
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
});
