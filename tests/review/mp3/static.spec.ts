/**
 * MP3 gate: the start page of the static build (see playwright.static.config.ts).
 *  - none: built without ANYWORLD_SERVER_URL: no rooms card, the offline demo starts;
 *  - up:   built with it, the server running: the rooms card is ok and a room can be created;
 *  - down: built with it, the server stopped: rooms shown as unavailable, single player starts.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'test-results/mp3-gate';
mkdirSync(OUT, { recursive: true });
const CASE = process.env.STATIC_CASE ?? 'none';

test(`static build, server ${CASE}`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem('anyworld.settings.v1', JSON.stringify({ quality: 'low', reduceMotion: true, audio: { volume: 0, muted: true } }));
    localStorage.setItem('anyworld.mp.profile', JSON.stringify({ name: 'Gate', colour: '#e6194b' }));
  });
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60_000 });
  const screen = () => page.evaluate(() => document.getElementById('ui-root')?.dataset.screen ?? '');
  if (CASE === 'none') {
    await expect(page.locator('.aw-rooms')).toHaveCount(0);
  } else if (CASE === 'up') {
    await expect(page.locator('.aw-rooms')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  } else {
    await expect(page.locator('.aw-rooms')).toHaveAttribute('data-status', 'unavailable', { timeout: 20_000 });
    await expect(page.locator('.aw-room-create')).toBeDisabled();
  }
  await page.screenshot({ path: `${OUT}/static-start-${CASE}.png` });
  if (CASE === 'up') {
    await page.locator('[data-friends="fixture-western"]').click();
    await expect(page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.aw-lobby-code')).toHaveText(/\S+/);
    await page.screenshot({ path: `${OUT}/static-lobby-up.png` });
  } else {
    await page.locator('.aw-demo[data-world="fixture-western"]').click();
    await expect.poll(screen, { timeout: 60_000 }).toBe('game');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${OUT}/static-game-${CASE}.png` });
  }
  expect(errors).toEqual([]);
});
