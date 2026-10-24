/**
 * M2 final gate: each fixture world is played by the explorer sim bot through the real UI (keyboard),
 * and screenshots are taken at the start, mid-run and after reaching a later area.
 * Screenshots: docs/progress/M2/final-<world>-*.png. 0 page errors are expected.
 * Run: xvfb-run -a npx playwright test e2e/final-m2.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });
const KEY: Record<string, string> = { n: 'ArrowUp', s: 'ArrowDown', e: 'ArrowRight', w: 'ArrowLeft', nw: 'y', ne: 'u', sw: 'b', se: 'n' };
const WORLDS = ['fixture-ship', 'fixture-teen', 'fixture-western', 'fixture-dream'] as const;

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

for (const [wi, world] of WORLDS.entries()) {
  test(`final ${world}: play through the UI and screenshot`, async ({ page }) => {
    test.setTimeout(600_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('final-init')) {
        localStorage.clear();
        sessionStorage.setItem('final-init', '1');
      }
    });
    const seed = 11 + wi;
    await page.goto(`/?world=${world}&seed=${seed}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.waitForTimeout(600);
    const shot = (name: string) => page.screenshot({ path: `${OUT}/final-${world}-${name}.png` });
    await shot('0-intro');
    for (let i = 0; i < 4 && (await layer(page)) !== 'game'; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    await shot('1-start');

    await page.evaluate(async ([seed, root]) => {
      const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
      (window as unknown as { __fb: unknown }).__fb = { bot: sim.botByName('explorer'), mem: sim.newMemory(seed) };
    }, [seed, process.cwd()] as const);

    let midShot = false;
    let laterShot = false;
    let startArea = -1;
    for (let i = 0; i < 600; i++) {
      const L = await layer(page);
      if (L === 'end') break;
      if (L === 'levelup' || L === 'choice') {
        await page.keyboard.press('1');
        await page.waitForTimeout(120);
        if ((await layer(page)) === L) await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
        continue;
      }
      if (L !== 'game') {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
        continue;
      }
      const d = await page.evaluate(() => {
        const fb = (window as unknown as { __fb: { bot: { decide: Function }; mem: unknown } }).__fb;
        const s = window.__anyworld!.controller!.session;
        return { a: fb.bot.decide(s.state, s.world, fb.mem), status: s.state.status, area: s.state.area.index };
      });
      if (d.status !== 'playing') break;
      if (startArea < 0) startArea = d.area;
      if (!midShot && i === 120) {
        await page.waitForTimeout(300);
        await shot('2-mid');
        midShot = true;
      }
      if (!laterShot && d.area > startArea && i > 0) {
        // let the area intro / camera settle, then capture a few steps into the new area
        for (let k = 0; k < 4 && (await layer(page)) !== 'game'; k++) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
        }
        await page.waitForTimeout(600);
        await shot('3-later-area');
        laterShot = true;
        break;
      }
      const k = d.a.type === 'move' ? KEY[d.a.dir] : d.a.type === 'wait' ? '.' : d.a.type === 'pickup' ? 'g' : d.a.type === 'transition' ? '>' : null;
      if (k) await page.keyboard.press(k);
      else await page.evaluate((a) => window.__anyworld!.controller!.actNow(a), d.a);
      await page.waitForTimeout(30);
    }
    if (!laterShot) {
      await page.waitForTimeout(400);
      await shot('3-later-area');
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
