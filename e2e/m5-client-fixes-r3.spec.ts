/**
 * Client fixes, M5 round 3, in the real app:
 *  - issues/M5-levelup-accidental-pick.md: a digit or Enter pressed as the level-up card opens does
 *    not pick a perk; after a short moment the digit works, and a mouse click works at once.
 *  - issues/M5-goal-route-items-unseen.md: in Pianissimo's third area the goal tracker names the
 *    Prompter's Last Cue lying there.
 * Screenshots: test-results/shots/M5/client-r3-*.png
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'test-results/shots/M5';
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/client-r3-${name}.png` });
const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

async function startWorld(page: Page, world: string, seed: number) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('fx-init')) {
      localStorage.clear();
      sessionStorage.setItem('fx-init', '1');
    }
  });
  await page.goto(`/?world=${world}&seed=${seed}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(800);
  for (let i = 0; i < 6 && (await layer(page)) === 'narration'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  await page.locator('.aw-onboard-ok').click({ timeout: 2000 }).catch(() => {});
}

const perkCount = (page: Page) => page.evaluate(() => (window.__anyworld!.controller!.session.state.player.perks ?? []).length);

test('level-up: keys pressed as the card opens are ignored; a moment later they pick', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await startWorld(page, 'fixture-teen', 31);
  const before = await perkCount(page);
  await page.evaluate(() => window.__anyworld!.controller!.gmNow([{ type: 'grant_xp', amount: 200 }]));
  await page.waitForFunction(() => window.__anyworld?.ui.layer() === 'levelup', null, { timeout: 5000 });
  // the rhythm of quick-slot keys + Enter the player was in
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  expect(await layer(page)).toBe('levelup');
  expect(await perkCount(page)).toBe(before);
  // no perk button holds the focus, so Enter cannot click one
  expect(await page.evaluate(() => document.activeElement?.classList.contains('aw-perk') ?? false)).toBe(false);
  await shot(page, 'levelup-guarded');
  await page.waitForTimeout(650);
  await page.keyboard.press('1');
  await expect.poll(() => perkCount(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});

test('level-up: a mouse click picks at once', async ({ page }) => {
  await startWorld(page, 'fixture-teen', 31);
  const before = await perkCount(page);
  await page.evaluate(() => window.__anyworld!.controller!.gmNow([{ type: 'grant_xp', amount: 200 }]));
  await page.waitForFunction(() => window.__anyworld?.ui.layer() === 'levelup', null, { timeout: 5000 });
  await page.locator('.aw-perk').first().click();
  await expect.poll(() => perkCount(page)).toBe(before + 1);
});

test('Pianissimo area 3: the goal tracker names the Prompter\'s Last Cue', async ({ page }) => {
  await startWorld(page, 'heist-silent-vault', 3);
  // walk the bot-free way: jump to area 3 through the engine's own transition (test set-up)
  for (let i = 0; i < 2; i++) {
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      await c.setStateForTest((st) => {
        const pl = st.area.actors.find((a) => a.id === st.player.actorId)!;
        pl.pos = { ...st.area.map.exit };
        const need = c.session.world.areas[st.area.index]?.transitionRequires;
        if (need && need.type === 'has_item') {
          const free = st.player.slots.findIndex((x, j) => j >= 8 && !x);
          st.player.slots[free] = { id: `e2e-${need.item}`, defId: need.item, count: 1 };
        }
      });
      c.actNow({ type: 'transition' } as never);
    });
    await page.waitForTimeout(400);
    for (let j = 0; j < 6 && (await layer(page)) !== 'game'; j++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
  }
  expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.area.index)).toBe(2);
  const goal = page.locator('.aw-goal');
  await expect(goal.locator('.aw-goal-step')).toContainText("Also here: The Prompter's Last Cue");
  await shot(page, 'pianissimo-also-here');
});
