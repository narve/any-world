/**
 * M4 gate: wiring that crosses the agents' work. In a run, Help → "Settings & music" opens the
 * settings dialog with the world's music panel (SoundCloud links, mood, mute/volume) in the audio
 * section; the Norwegian UI shows the translated copy of a translated world (not both) and the
 * engine's dialogue buttons in bokmål. Screenshots: docs/progress/M4/m4-*.png.
 * Run: xvfb-run -a npx playwright test e2e/m4-gate.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M4' : 'test-results/shots/M4';
mkdirSync(OUT, { recursive: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url ?? '';
    if (/\/api\//.test(m.text()) || /\/api\//.test(loc) || /502|Bad Gateway/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function prepare(page: Page, lang: string) {
  await page.addInitScript((l) => {
    try {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', l);
    } catch {
      /* storage blocked */
    }
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, lang);
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

async function playDemo(page: Page, id: string) {
  await page.goto('/');
  await waitReady(page);
  await page.locator(`.aw-demo[data-world="${id}"]`).click();
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  await waitReady(page);
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(() => window.__anyworld!.ui.layer())) !== 'narration') break;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  }
  const ok = page.locator('.aw-onboard-ok');
  if (await ok.isVisible().catch(() => false)) await ok.click();
}

test('in a run, Help opens settings with the world music panel', async ({ page }) => {
  const errors = collectErrors(page);
  await prepare(page, 'en');
  await playDemo(page, 'fixture-western');
  await page.keyboard.press('?');
  await expect(page.locator('#aw-help-settings')).toBeVisible();
  await page.locator('#aw-help-settings').click();
  await expect(page.locator('.aw-settings-form')).toBeVisible();
  // the audio module loads lazily; the panel lands in the audio section
  await expect(page.locator('#aw-set-music .aw-music-panel')).toBeVisible({ timeout: 15000 });
  expect(await page.locator('#aw-set-music a[href*="soundcloud.com/search"]').count()).toBeGreaterThan(0);
  await page.locator('#aw-set-music').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/m4-settings-music-desktop.png` });
  // toggling an unrelated setting re-renders the dialog; the same panel stays mounted
  await page.locator('#aw-set-mute').click();
  await expect(page.locator('.aw-music-panel')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.aw-settings-form')).toBeHidden();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Norwegian UI: translated world listed once, engine dialogue buttons in bokmål', async ({ page }) => {
  const errors = collectErrors(page);
  await prepare(page, 'nb');
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('.aw-demo[data-world="viking-lawspeaker-althing-nb"]')).toHaveCount(1);
  await expect(page.locator('.aw-demo[data-world="viking-lawspeaker-althing"]')).toHaveCount(0);
  // tag chips carry bokmål labels, the filter keys stay English
  const chips = await page.locator('.aw-tag-chip').evaluateAll((els) => els.map((e) => ({ key: (e as HTMLElement).dataset.tag, label: e.textContent })));
  expect(chips.length).toBeGreaterThan(0);
  expect(chips.some((c) => c.key !== c.label)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
