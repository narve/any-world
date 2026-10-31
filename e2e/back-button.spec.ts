/**
 * The browser's Back and Forward buttons (src/client/nav.ts): a run opened from the start page gets
 * its own history entry, Back closes an open panel or dialog first, then returns to the start page
 * (the run stays saved), and Forward resumes the same run.
 * Run: xvfb-run -a npx playwright test e2e/back-button.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

async function prepare(page: Page) {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('aw-e2e-cleared')) {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'en');
        sessionStorage.setItem('aw-e2e-cleared', '1');
      }
    } catch {
      /* storage blocked */
    }
    // other agents edit files while this runs: keep Vite's HMR from reloading the page mid-test
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  });
}

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');
const screen = (page: Page) => page.evaluate(() => window.__anyworld?.screen ?? 'none');

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

/** past the intro narration and the first-run card, to the map */
async function toMap(page: Page) {
  for (let i = 0; i < 6 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  expect(await layer(page)).toBe('game');
}

test('Back closes panels first, then returns to the start page; Forward resumes the run', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await prepare(page);
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('.aw-start')).toBeVisible();

  // the settings dialog on the start page: Back closes it and stays on the page
  await page.locator('.aw-start-settings').click();
  await expect.poll(() => layer(page)).toBe('settings');
  await page.goBack();
  await expect.poll(() => layer(page)).toBe('start');
  expect(new URL(page.url()).search).toBe('');

  // a ready-made world: its own address
  await page.locator('.aw-demo').first().click();
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  await waitReady(page);
  await toMap(page);
  const runUrl = page.url();
  expect(new URL(runUrl).searchParams.get('world')).toBeTruthy();
  const worldId = await page.evaluate(() => window.__anyworld!.controller!.session.worldId);

  // take a turn so the autosave has something
  await page.keyboard.press('.');
  await page.waitForTimeout(300);
  const turn = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);

  // help: Back closes it, the run stays
  await page.keyboard.press('?');
  await expect.poll(() => layer(page)).toBe('help');
  await page.goBack();
  await expect.poll(() => layer(page)).toBe('game');
  expect(page.url()).toBe(runUrl);

  // a panel closed by its own key steps back over its entry: the next Back leaves the run
  await page.keyboard.press('?');
  await expect.poll(() => layer(page)).toBe('help');
  await page.keyboard.press('Escape');
  await expect.poll(() => layer(page)).toBe('game');
  await page.waitForTimeout(200);

  await page.goBack();
  await expect.poll(() => screen(page)).toBe('start');
  await expect(page.locator('.aw-start')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  // the run is saved: Continue is offered
  await expect(page.locator('.aw-start')).toContainText(/continue/i);

  // Forward resumes the same run where it was
  await page.goForward();
  await expect.poll(() => screen(page)).toBe('game');
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  expect(page.url()).toBe(runUrl);
  const back = await page.evaluate(() => ({ id: window.__anyworld!.controller!.session.worldId, turn: window.__anyworld!.controller!.session.state.turn }));
  expect(back.id).toBe(worldId);
  expect(back.turn).toBeGreaterThanOrEqual(turn);

  expect(errors, errors.join('\n')).toEqual([]);
});
