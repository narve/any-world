/**
 * Review M5 round 2 (code): direct-mode API key storage. Settings keep ONE `provider.apiKey` for
 * every preset, and the settings dialog's preset <select> (screens.ts SettingsDialog) changes
 * preset / model / base URL but never the key. A player who typed an Anthropic key and then picks
 * OpenRouter (or Ollama / LM Studio / a custom URL) sends the Anthropic key as
 * `Authorization: Bearer …` to that other host with the next request.
 */
import { test, expect } from '@playwright/test';

const SECRET = 'sk-ant-review-secret-0123456789';

test('switching presets does not send the previous provider\'s key to the new host', async ({ page }) => {
  await page.addInitScript((secret) => {
    if (!sessionStorage.getItem('r2-init')) {
      sessionStorage.setItem('r2-init', '1');
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', 'en');
      localStorage.setItem('anyworld.settings.v1', JSON.stringify({ provider: { preset: 'anthropic', transport: 'direct', apiKey: secret } }));
    }
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, SECRET);
  const seen: { url: string; auth: string }[] = [];
  await page.route('https://openrouter.ai/**', async (route) => {
    const req = route.request();
    seen.push({ url: req.url(), auth: req.headers()['authorization'] ?? '' });
    await route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify({ error: { message: 'bad key' } }) });
  });
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.locator('.aw-start-settings').click();
  await expect(page.locator('#aw-set-preset')).toBeVisible();
  await expect(page.locator('#aw-set-key')).toHaveValue(SECRET);
  await page.locator('#aw-set-preset').selectOption('openrouter');
  await page.locator('#aw-set-transport-direct').check();
  // the key field still shows (and keeps) the Anthropic key for OpenRouter
  const shown = await page.locator('#aw-set-key').inputValue();
  await page.locator('#aw-set-save').click();
  await expect(page.locator('#aw-set-preset')).toBeHidden();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('anyworld.settings.v1') ?? '{}').provider);
  await page.locator('#aw-prompt').fill('A teen drama at a flooded school');
  await page.getByRole('button', { name: 'Create world' }).click();
  await expect.poll(() => seen.length, { timeout: 20000 }).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/r2-code-key-leak.png' });
  // repro: shown === SECRET, stored = {preset:'openrouter', apiKey: SECRET}, seen[0].auth === `Bearer ${SECRET}`
  expect({ shown, storedKey: stored.apiKey ?? null, sentToOpenRouter: seen[0]!.auth.includes(SECRET) }).toEqual({ shown: '', storedKey: null, sentToOpenRouter: false });
});
