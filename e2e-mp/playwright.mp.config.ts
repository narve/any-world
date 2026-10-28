/**
 * The room specs (MP3 design §7): their own dev server on 5183 (client) / 8797 (API), so the other
 * specs' server on 5173 and other agents are never touched (E2E_MP_PORT / E2E_MP_API_PORT move
 * them). The server gets a fresh data dir under .data/ (removed in the global teardown), test
 * timing (600 ms deadline, 30 ms travel, 150 ms countdown turns), fixed run seeds and raised limits
 * (every page is on 127.0.0.1). One worker; Chromium is kept from throttling or hiding windows that
 * overlap under xvfb (that would send presence: menu).
 *
 * Run: xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts --reporter=line
 */
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const PORT = Number(process.env.E2E_MP_PORT) || 5183;
const API_PORT = Number(process.env.E2E_MP_API_PORT) || 8797;
// (set once in the main process; the workers and the teardown inherit it)
process.env.E2E_MP_DATA ??= resolve(HERE, '..', '.data', `e2e-mp-${Date.now()}`);

export const MP_TIMING = { deadlineMs: 600, travelMs: 30, countdownTurnMs: 150 };
export const MP_SEED = 4242;
export const MP_LIMITS = { createsPer10Min: 500, upgradesPerMin: 1000, socketsPerIp: 200, listPerMin: 2000, maxRooms: 50 };

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 240_000,
  workers: 1,
  globalTeardown: './teardown.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    channel: 'chromium',
    headless: false,
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
    },
  },
  webServer: {
    command: 'npx tsx server/dev.ts',
    cwd: resolve(HERE, '..'),
    port: PORT,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      PORT: String(API_PORT),
      ANYWORLD_CLIENT_PORT: String(PORT),
      ANYWORLD_DATA_DIR: process.env.E2E_MP_DATA,
      ANYWORLD_TEST_TIMING: JSON.stringify(MP_TIMING),
      ANYWORLD_TEST_SEED: String(MP_SEED),
      ANYWORLD_TEST_LIMITS: JSON.stringify(MP_LIMITS),
    },
  },
});
