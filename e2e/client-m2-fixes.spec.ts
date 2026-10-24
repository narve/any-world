/**
 * Client fixes after playtest round 1 (issues/M2-*.md owned by the client), checked in the real
 * app: 'p' in a conversation, direction aiming, the full-vital warning, the objective hint line and
 * the queued level-up badge. Screenshots: docs/progress/M2/client-fix-*.png
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/progress/M2';
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/client-fix-${name}.png` });
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
  await page.locator('.aw-hints button').first().click().catch(() => {});
}

test('ship: full O2 warns before spending a canister; Arc Weld aims by direction', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await startWorld(page, 'fixture-ship', 21);
  const count = () => page.evaluate(() => window.__anyworld!.controller!.session.state.player.slots[2]?.count ?? 0);
  const c0 = await count();
  await page.keyboard.press('3');
  await page.waitForTimeout(300);
  await expect(page.locator('.aw-toast').filter({ hasText: 'already full' })).toBeVisible();
  expect(await count()).toBe(c0);
  await shot(page, 'o2-full-warning');
  await page.keyboard.press('3');
  await page.waitForTimeout(300);
  expect(await count()).toBe(c0 - 1);

  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  expect(await layer(page)).toBe('target');
  await expect(page.locator('.aw-mode-banner')).toContainText('arrow keys pick a direction');
  const aim = await page.evaluate(() => window.__anyworld!.controller!.session.aim());
  expect(aim).not.toBeNull();
  expect(aim!.at).not.toEqual(aim!.from);
  await expect(page.locator('.ov-dirs')).toHaveAttribute('visibility', 'visible');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  await shot(page, 'weld-direction');
  const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const t1 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
  expect(t1).toBeGreaterThan(t0);
  expect(await layer(page)).toBe('game');
  expect(errors).toEqual([]);
});

test('teen: p persuades inside a conversation; objective hint on its own line; queued levels badge', async ({ page }) => {
  await startWorld(page, 'fixture-teen', 33);
  await expect(page.locator('.aw-objective-hint')).toBeVisible();
  await shot(page, 'objective');
  const hint = page.locator('.aw-objective-hint');
  const clipped = await hint.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  expect(clipped).toBe(false);

  const talked = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const st = c.session.state;
    const npcIds = new Set(c.session.world.actors.filter((a) => a.npc).map((a) => a.id));
    const t = st.area.actors.find((a) => npcIds.has(a.defId));
    if (!t) return null;
    const m = st.area.map;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = t.pos.x + dx;
      const y = t.pos.y + dy;
      const tile = m.tiles[y * m.width + x];
      if (!tile || !(tile.kind === 'floor' || tile.kind === 'start' || tile.kind === 'door_open')) continue;
      if (st.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((s) => {
        s.area.actors = s.area.actors.filter((a) => a.id === s.player.actorId || a.faction !== 'hostile');
        s.area.actors.find((a) => a.id === s.player.actorId)!.pos = { x, y };
      });
      c.actNow({ type: 'wait' });
      return t.id;
    }
    return null;
  });
  expect(talked).not.toBeNull();
  await page.keyboard.press('t');
  await page.waitForTimeout(600);
  expect(await layer(page)).toBe('dialogue');
  await expect(page.locator('.aw-dlg-foot')).toContainText('Persuade');
  const logLen = await page.evaluate(() => window.__anyworld!.controller!.session.state.log.length);
  await page.keyboard.press('p');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-4).map((l) => l.text));
  const grew = await page.evaluate((n) => window.__anyworld!.controller!.session.state.log.length > n, logLen);
  expect(grew).toBe(true);
  await shot(page, 'persuade-key');
  expect(after.join(' ')).not.toMatch(/no one nearby/i);

  for (let i = 0; i < 4 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.__anyworld!.controller!.gmNow([{ type: 'grant_xp', amount: 200 }]));
  await page.waitForTimeout(700);
  const xpText = await page.locator('.aw-bar[data-bar="xp"] .aw-bar-value').textContent();
  const [a, b] = (xpText ?? '0 / 1').split('/').map((x) => Number(x.trim()));
  expect(a).toBeLessThanOrEqual(b);
  await expect(page.locator('.aw-xp-pending')).toBeVisible();
  await shot(page, 'xp-pending');
});

// issues/M2-sell-column-dead-ui.md: no trader buys anything, so the trade window has no dead Sell column
test('ship: trade window shows only the Buy column when the trader buys nothing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await startWorld(page, 'fixture-ship', 21);
  const npcId = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const st = c.session.state;
    const m = st.area.map;
    const t = st.area.actors.find((a) => a.defId === 'bosun-kettering');
    if (!t) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = t.pos.x + dx;
      const y = t.pos.y + dy;
      const tile = m.tiles[y * m.width + x];
      if (!tile || !(tile.kind === 'floor' || tile.kind === 'start' || tile.kind === 'door_open')) continue;
      if (st.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((s) => {
        s.area.actors = s.area.actors.filter((a) => a.id === s.player.actorId || a.faction !== 'hostile');
        s.area.actors.find((a) => a.id === s.player.actorId)!.pos = { x, y };
        s.player.currency = 70;
      });
      c.actNow({ type: 'wait' });
      return t.id;
    }
    return null;
  });
  expect(npcId).not.toBeNull();
  await page.waitForTimeout(400);
  for (let i = 0; i < 4 && (await layer(page)) === 'narration'; i++) await page.keyboard.press('Escape');
  await page.keyboard.press('t'); // talk
  await page.waitForTimeout(500);
  await page.keyboard.press('t'); // trade from the conversation
  await page.waitForTimeout(500);
  expect(await layer(page)).toBe('trade');
  const heads = await page.locator('.aw-trade-cols h3').allTextContents();
  expect(heads.map((x) => x.trim().toLowerCase())).toEqual(['buy']);
  await expect(page.locator('.aw-trade')).not.toContainText('Nothing they want');
  await expect(page.locator('.aw-trade-cols')).toHaveClass(/aw-trade-cols-single/);
  expect(await page.locator('.aw-trade-row').count()).toBeGreaterThan(0);
  await shot(page, 'trade-buy-only');
  expect(errors).toEqual([]);
});
