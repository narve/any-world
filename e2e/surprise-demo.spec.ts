/**
 * "Surprise me" with no usable AI (the dev/backend server here has no provider keys): the start screen
 * must not send the player to Settings; the app plays a random recorded demo world instead.
 * Run: xvfb-run -a npx playwright test e2e/surprise-demo.spec.ts
 */
import { test, expect } from '@playwright/test';


test('backend without a key: "Surprise me" plays a demo world, "Create world" asks for a provider', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('aw-e2e-init')) {
        sessionStorage.setItem('aw-e2e-init', '1');
        localStorage.clear();
        localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
        localStorage.setItem('anyworld.lang.v1', 'en');
      }
    } catch {
      /* storage blocked */
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  // the server answered /api/presets with no configured keys
  await expect(page.locator('.aw-start-note')).toHaveAttribute('data-tone', 'warn');

  await page.getByRole('button', { name: 'Create world' }).click();
  await expect(page.locator('#aw-set-preset')).toBeVisible();
  await page.locator('#aw-set-preset').press('Escape');
  await expect(page.locator('#aw-set-preset')).toBeHidden();

  await page.getByRole('button', { name: 'Surprise me' }).click();
  await page.waitForFunction(() => document.getElementById('ui-root')?.dataset.screen === 'game' && !!window.__anyworld?.controller, null, { timeout: 60000 });
  const id = await page.evaluate(() => window.__anyworld!.controller!.session.worldId);
  expect(id).not.toMatch(/^gen-|^fixture-/);
  await expect(page.locator('#aw-set-preset')).toBeHidden();
  expect(errors).toEqual([]);
});
