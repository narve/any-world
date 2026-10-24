/**
 * Playtester round, hands-on part: the things a player does by hand that the bot run does not
 * cover through the UI — hotbar use of every use mode, backpack equip by mouse, unknown items,
 * talk / persuade / trade with a merchant, the rules panel (incl. a GM-added rule), the
 * difficulty slider on the start screen and a level-up perk picked with the mouse.
 * Screenshots: docs/progress/M2/playtest-r<ROUND>-ui-*.png; facts: playtest-r<ROUND>-ui.json.
 * Run: PLAYTEST_ROUND=1 xvfb-run -a npx playwright test e2e/playtest-ui.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const ROUND = process.env.PLAYTEST_ROUND ?? '1';
// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/playtest-r${ROUND}-ui-${name}.png` });
const FACTS = `${OUT}/playtest-r${ROUND}-ui.json`;
function fact(key: string, value: unknown) {
  const f = existsSync(FACTS) ? JSON.parse(readFileSync(FACTS, 'utf8')) : {};
  f[key] = value;
  writeFileSync(FACTS, JSON.stringify(f, null, 2));
}



async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(400);
}
const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');
async function skipNarration(page: Page) {
  for (let i = 0; i < 6 && (await layer(page)) === 'narration'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}
async function slots(page: Page) {
  return page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    const p = s.state.player;
    return p.slots.map((x, i) => (x ? { i, def: x.defId, count: (x as { count?: number }).count ?? 1, charges: (x as { charges?: number }).charges, eq: Object.values(p.equipped).includes(i), cd: (x as { cooldown?: number }).cooldown } : null));
  });
}
async function startWorld(page: Page, world: string, seed: number) {
  // clear storage once per test, not on reloads (a reload must find the autosave)
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('pt-init')) {
      localStorage.clear();
      sessionStorage.setItem('pt-init', '1');
    }
  });
  await page.goto(`/?world=${world}&seed=${seed}`);
  await waitReady(page);
  await page.waitForTimeout(600);
  await skipNarration(page);
  await page.locator('.aw-onboard-ok').click({ timeout: 2000 }).catch(() => {});
}
/** clears hostiles and puts the player on a free floor tile next to an actor with defId */
async function standNextTo(page: Page, defId: string) {
  return page.evaluate(async (defId) => {
    const c = window.__anyworld!.controller!;
    const st = c.session.state;
    const m = st.area.map;
    const t = st.area.actors.find((a) => a.defId === defId);
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
      });
      c.actNow({ type: 'wait' });
      return { id: t.id, pos: t.pos };
    }
    return null;
  }, defId);
}

test('ship: hotbar use modes, unknown item, backpack equip by mouse', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await startWorld(page, 'fixture-ship', 21);
  const s0 = await slots(page);
  fact('ship-start-slots', s0);
  await shot(page, 'ship-00-start');

  // consumed: O2 canister in slot 3 (tank is full at the start)
  await page.keyboard.press('3');
  await page.waitForTimeout(400);
  const afterO2 = await slots(page);
  const o2Log = await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-2).map((l) => l.text));
  const o2Toast = await page.evaluate(() => document.querySelector('.aw-toast')?.textContent ?? null);
  fact('consumed-o2', { before: s0[2], after: afterO2[2], log: o2Log, layer: await layer(page), toast: o2Toast, startCurrency: await page.evaluate(() => window.__anyworld!.controller!.session.state.player.currency) });
  await shot(page, 'ship-01-consumed');

  // charges: signal flare slot 5 (may want a target)
  await page.keyboard.press('5');
  await page.waitForTimeout(400);
  const flareLayer = await layer(page);
  await shot(page, 'ship-02-charges-target');
  if (flareLayer === 'target') {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }
  const afterFlare = await slots(page);
  fact('charges-flare', { layer: flareLayer, before: s0[4], after: afterFlare[4], log: await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-3).map((l) => l.text)) });
  await shot(page, 'ship-03-charges-used');

  // reusable: arc-weld slot 2 (costs a resource, has a cooldown)
  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  const weldLayer = await layer(page);
  const weldCursor = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session as unknown as { cursor: unknown; player(): { pos: unknown } };
    return { banner: document.querySelector('.aw-mode-banner')?.textContent ?? null, player: s.player().pos, cursor: s.cursor };
  });
  fact('weld-cursor', weldCursor);
  await shot(page, 'ship-04-reusable');
  if (weldLayer === 'target') {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }
  const weld1 = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    return { res: { ...s.state.player.resources }, log: s.state.log.slice(-3).map((l) => l.text), turn: s.state.turn };
  });
  // press again straight away: cooldown should block it with a clear message
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  if ((await layer(page)) === 'target') await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const weld2 = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    return { log: s.state.log.slice(-2).map((l) => l.text), turn: s.state.turn, toast: document.querySelector('.aw-toast')?.textContent ?? null };
  });
  fact('reusable-weld', { layer: weldLayer, weld1, weld2, slot: (await slots(page))[1] });
  await shot(page, 'ship-05-reusable-cooldown');

  // passive equip: give a vest and an unknown ampoule, equip the vest via backpack clicks
  await page.evaluate(() => window.__anyworld!.controller!.gmNow([{ type: 'give_item', item: 'moss-vest', count: 1 }, { type: 'give_item', item: 'ampoule-stim', count: 1 }, { type: 'currency', amount: 40 }]));
  await page.waitForTimeout(400);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  fact('backpack-layer', await layer(page));
  await shot(page, 'ship-06-backpack');
  const sl = await slots(page);
  const vestIdx = sl.findIndex((x) => x?.def === 'moss-vest');
  const ampIdx = sl.findIndex((x) => x?.def === 'ampoule-stim');
  fact('given', { vestIdx, ampIdx });
  const slotBtns = page.locator('.aw-backpack .aw-slot');
  fact('backpack-slot-buttons', await slotBtns.count());
  await slotBtns.nth(vestIdx).click();
  await page.waitForTimeout(300);
  await shot(page, 'ship-07-backpack-vest-selected');
  const actions = await page.locator('.aw-bp-actions button').allTextContents();
  fact('vest-menu', actions);
  const equipBtn = page.locator('.aw-bp-actions button', { hasText: /equip|wear|put on/i }).first();
  if (await equipBtn.count()) {
    await equipBtn.click();
    await page.waitForTimeout(400);
  }
  const eq = await page.evaluate((i) => Object.values(window.__anyworld!.controller!.session.state.player.equipped).includes(i), vestIdx);
  fact('vest-equipped', eq);
  await shot(page, 'ship-08-vest-equipped');

  // unknown item: inspect then use from the backpack
  const sl2 = await slots(page);
  const amp2 = sl2.findIndex((x) => x?.def === 'ampoule-stim');
  await slotBtns.nth(amp2).click();
  await page.waitForTimeout(300);
  const inspect = await page.locator('.aw-bp-inspect').innerText().catch(() => '');
  fact('unknown-inspect', inspect);
  await shot(page, 'ship-09-unknown-inspect');
  const useBtn = page.locator('.aw-bp-actions button').first();
  const useLabel = await useBtn.textContent();
  await useBtn.click();
  await page.waitForTimeout(500);
  if ((await layer(page)) === 'target') {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }
  fact('unknown-used', { label: useLabel, log: await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-4).map((l) => l.text)), layer: await layer(page) });
  await shot(page, 'ship-10-unknown-used');
  if ((await layer(page)) === 'backpack') await page.keyboard.press('Escape');

  // talk, trade, persuade with the bosun (has stock)
  await page.waitForTimeout(300);
  const bosun = await standNextTo(page, 'bosun-kettering');
  fact('bosun', bosun);
  await page.waitForTimeout(500);
  await skipNarration(page);
  await page.keyboard.press('t');
  await page.waitForTimeout(600);
  fact('talk-layer', await layer(page));
  await shot(page, 'ship-11-talk');
  const opts = await page.locator('.aw-dialogue button, .aw-modal button').allTextContents();
  fact('talk-options', opts);
  const curTalk = await page.evaluate(() => window.__anyworld!.controller!.session.state.player.currency);
  await page.keyboard.press('t');
  await page.waitForTimeout(500);
  fact('t-in-dialogue', { layer: await layer(page), currencyBeforeGmGift: curTalk });
  const tradeOpt = page.locator('button', { hasText: /trade|buy|wares|stock|deal/i }).first();
  if ((await layer(page)) !== 'trade' && (await tradeOpt.count())) {
    await tradeOpt.click();
    await page.waitForTimeout(500);
  }
  fact('trade-layer', await layer(page));
  await shot(page, 'ship-12-trade');
  const tradeText = await page.locator('.aw-trade').innerText().catch(() => '');
  fact('trade-text', tradeText.slice(0, 800));
  const cur0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.player.currency);
  // buy the first thing (key 1), then confirm if needed
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const cur1 = await page.evaluate(() => window.__anyworld!.controller!.session.state.player.currency);
  fact('trade-buy', { cur0, cur1, log: await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-3).map((l) => l.text)) });
  await shot(page, 'ship-13-trade-bought');
  for (let i = 0; i < 3 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('t');
  await page.waitForTimeout(500);
  const pl0 = await layer(page);
  await page.keyboard.press('p');
  await page.waitForTimeout(600);
  fact('persuade', { before: pl0, layer: await layer(page), log: await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-3).map((l) => l.text)) });
  await shot(page, 'ship-14-persuade');
  for (let i = 0; i < 3 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // rules panel, then a GM-added rule
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  fact('rules-layer', await layer(page));
  await shot(page, 'ship-15-rules');
  await page.keyboard.press('Escape');
  const ruleRes = await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    c.gmNow([{ type: 'add_rule', rule: { id: 'pt-low-light', name: 'Low Light', description: 'The deck lights dim to save power. You see less far.', playerTriggers: [], switches: { darkness: 0.6 } }, reason: 'MATRON rations the lamps.' }]);
    const st = c.session.state as unknown as { activeRules?: unknown[] };
    return { activeRules: st.activeRules ?? null, log: c.session.state.log.slice(-3).map((l) => l.text) };
  });
  await page.waitForTimeout(600);
  fact('gm-add-rule', ruleRes);
  await shot(page, 'ship-16-gm-rule-toast');
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  fact('rules-panel-after-gm', (await page.locator('.aw-rules, .aw-modal').first().innerText().catch(() => '')).slice(0, 1200));
  await shot(page, 'ship-17-rules-after-gm');
  // second GM rule in the same area must be refused quietly (per-area limit 1), not shown in the log
  const second = await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    const n0 = (c.session.state as unknown as { activeRules?: unknown[] }).activeRules?.length ?? -1;
    c.gmNow([{ type: 'add_rule', rule: { id: 'pt-second', name: 'Second', description: 'x', playerTriggers: [], switches: { darkness: 0.5 } }, reason: 'test' }]);
    const n1 = (c.session.state as unknown as { activeRules?: unknown[] }).activeRules?.length ?? -1;
    return { n0, n1, log: c.session.state.log.slice(-3).map((l) => l.text) };
  });
  fact('gm-second-rule', second);
  await page.keyboard.press('Escape');
  fact('ship-errors', errors);
});

test('start screen: difficulty slider changes the run', async ({ page }) => {
  const runs: Record<string, unknown> = {};
  for (const [v, name] of [['0', 'gentle'], ['3', 'brutal']] as const) {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await waitReady(page);
    await page.locator('#aw-diff').fill(v);
    await page.waitForTimeout(200);
    await shot(page, `start-${name}`);
    await page.locator('.aw-demo').first().click();
    await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
    await waitReady(page);
    runs[name] = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      const hostiles = s.state.area.actors.filter((a) => a.faction === 'hostile');
      const st = s.state as unknown as { difficulty?: string };
      return { difficulty: s.difficulty, engineDifficulty: st.difficulty ?? null, hostileMaxHp: hostiles.map((a) => a.maxHp), world: s.worldId, url: location.href, playerHp: s.player().hp, hostiles: hostiles.length, hostileHp: hostiles.reduce((n, a) => n + a.hp, 0), items: s.state.area.items.length };
    });
  }
  fact('difficulty', runs);
});

test('teen: level-up perk picked with the mouse; dream: rules + reload in a modal', async ({ page }) => {
  await startWorld(page, 'fixture-teen', 31);
  await page.evaluate(() => window.__anyworld!.controller!.gmNow([{ type: 'grant_xp', amount: 200 }]));
  await page.waitForTimeout(700);
  const L = await layer(page);
  const lvlInfo = await page.evaluate(() => ({
    xp: document.querySelector('.aw-xp, [class*=xp]')?.textContent ?? null,
    pending: document.querySelector('.aw-xp-pending')?.textContent ?? null,
    cards: [...document.querySelectorAll('.aw-levelup button, .aw-perk')].map((b) => ({ text: (b as HTMLElement).innerText.slice(0, 160), chips: b.querySelectorAll('.aw-chip, [class*=chip], [class*=effect]').length })),
  }));
  fact('levelup-info', lvlInfo);
  await shot(page, 'teen-levelup');
  const cards = page.locator('.aw-levelup button, .aw-perk');
  const n = await cards.count();
  const before = await page.evaluate(() => ({ lvl: window.__anyworld!.controller!.session.state.player.level, perks: [...(window.__anyworld!.controller!.session.state.player.perks ?? [])] }));
  if (n > 1) {
    await cards.nth(1).click();
    await page.waitForTimeout(300);
    if ((await layer(page)) === 'levelup') {
      await cards.nth(1).click();
      await page.waitForTimeout(300);
    }
  }
  const after = await page.evaluate(() => ({ lvl: window.__anyworld!.controller!.session.state.player.level, perks: [...(window.__anyworld!.controller!.session.state.player.perks ?? [])], layer: window.__anyworld!.ui.layer() }));
  fact('levelup-mouse', { layer: L, cards: n, before, after });
  await shot(page, 'teen-levelup-picked');
  // more levels queued? play them through with the keyboard
  for (let i = 0; i < 5 && (await layer(page)) === 'levelup'; i++) {
    await page.keyboard.press('1');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }

  // reload while a dialogue is open
  await standNextTo(page, 'priya');
  await page.waitForTimeout(400);
  await page.keyboard.press('t');
  await page.waitForTimeout(500);
  const dl = await layer(page);
  const st0 = await page.evaluate(() => ({ turn: window.__anyworld!.controller!.session.state.turn, url: location.href }));
  await page.reload();
  await waitReady(page);
  await page.waitForTimeout(600);
  const st1 = await page.evaluate(() => ({ turn: window.__anyworld?.controller?.session.state.turn ?? null, layer: window.__anyworld?.ui.layer(), url: location.href }));
  fact('reload-in-dialogue', { dl, st0, st1 });
  await shot(page, 'teen-reload-after-dialogue');

  // dream: rules panel (drop the teen autosave first, or the start screen asks to continue it)
  await page.evaluate(() => localStorage.clear());
  await page.goto('/?world=fixture-dream&seed=41');
  await waitReady(page);
  await skipNarration(page);
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  await shot(page, 'dream-rules');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.waitForTimeout(300);
  await shot(page, 'dream-help');
  await page.keyboard.press('Escape');
  expect(true).toBe(true);
});

test('teen: persuade from dialogue, reload with a dialogue open, GM rule on a fresh budget, click-to-walk', async ({ page }) => {
  await startWorld(page, 'fixture-teen', 33);
  // GM rule first, with the whole budget available
  const rule = await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    c.gmNow([{ type: 'add_rule', rule: { id: 'pt-rain', name: 'Endless Drizzle', description: 'It will not stop raining. Everyone moves a little slower.', playerTriggers: [], switches: { darkness: 0.7 } }, reason: 'The reservoir is rising.' }]);
    const st = c.session.state as unknown as { activeRules?: unknown[] };
    return { activeRules: st.activeRules ?? null, log: c.session.state.log.slice(-2).map((l) => l.text), badge: document.querySelector('.aw-rules-badge')?.textContent ?? null };
  });
  await page.waitForTimeout(500);
  fact('gm-add-rule-fresh', rule);
  await shot(page, 'teen-gm-rule');
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  fact('teen-rules-panel', (await page.locator('.aw-rules, .aw-modal').first().innerText().catch(() => '')).slice(-500));
  await shot(page, 'teen-rules-gm');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // click-to-walk: click a floor tile 4 steps away
  const tgt = await page.evaluate(() => {
    const app = window.__anyworld!;
    const s = app.controller!.session;
    const p = s.player().pos;
    const m = s.state.area.map;
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) {
        if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) !== 4) continue;
        const pv = s.preview({ x, y });
        if (pv?.kind !== 'walk') continue;
        const sc = app.renderer!.tileToScreen({ x, y });
        if (document.elementFromPoint(sc.x, sc.y)?.tagName === 'CANVAS') return { tile: { x, y }, sc, from: p };
      }
    return null;
  });
  if (tgt) {
    await page.mouse.move(tgt.sc.x, tgt.sc.y);
    await page.waitForTimeout(200);
    await page.mouse.click(tgt.sc.x, tgt.sc.y);
    await page.waitForTimeout(2500);
  }
  const walked = await page.evaluate(() => window.__anyworld!.controller!.session.player().pos);
  fact('click-walk', { tgt, walked });
  await shot(page, 'teen-click-walk');

  // persuade: stand next to an NPC in this area that can be persuaded, talk, press p
  const npc = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    const ids = new Set(s.world.actors.filter((a) => a.npc).map((a) => a.id));
    return s.state.area.actors.find((a) => ids.has(a.defId))?.defId ?? null;
  });
  fact('teen-npc', npc);
  if (npc) {
    await standNextTo(page, npc);
    await page.waitForTimeout(400);
    await skipNarration(page);
    await page.keyboard.press('t');
    await page.waitForTimeout(500);
    const l1 = await layer(page);
    await shot(page, 'teen-talk');
    await page.keyboard.press('p');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({ layer: window.__anyworld!.ui.layer(), log: window.__anyworld!.controller!.session.state.log.slice(-4).map((l) => l.text), turn: window.__anyworld!.controller!.session.state.turn }));
    fact('persuade-teen', { npc, l1, after });
    await shot(page, 'teen-persuade');
    // the dialogue shows a "Persuade [p]" button: try it with the mouse too
    const pbtn = page.locator('button', { hasText: /^Persuade/ }).first();
    const hasBtn = (await pbtn.count()) > 0 && (await pbtn.isVisible());
    if (hasBtn) {
      await pbtn.click();
      await page.waitForTimeout(600);
    }
    fact('persuade-teen-click', { hasBtn, layer: await layer(page), log: await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-3).map((l) => l.text)) });
    await shot(page, 'teen-persuade-click');
    if ((await layer(page)) !== 'dialogue') {
      await page.keyboard.press('t');
      await page.waitForTimeout(500);
    }
    const st0 = await page.evaluate(() => ({ turn: window.__anyworld!.controller!.session.state.turn, layer: window.__anyworld!.ui.layer(), pos: window.__anyworld!.controller!.session.player().pos }));
    await page.reload();
    await waitReady(page);
    await page.waitForTimeout(700);
    const st1 = await page.evaluate(() => ({ turn: window.__anyworld?.controller?.session.state.turn ?? null, layer: window.__anyworld?.ui.layer(), pos: window.__anyworld?.controller?.session.player().pos, rules: (window.__anyworld?.controller?.session.state as unknown as { activeRules?: unknown[] }).activeRules ?? null }));
    fact('reload-in-dialogue-2', { st0, st1 });
    await shot(page, 'teen-reload-in-dialogue');
  }
});

test('western: dying shows a loss screen and a fresh start works', async ({ page }) => {
  await startWorld(page, 'fixture-western', 51);
  await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const foe = c.session.world.actors.find((a) => !a.npc && !a.unique && a.faction === 'hostile')!;
    c.gmNow([{ type: 'spawn', actor: foe.id, count: 3, near: 'player' }]);
    await c.setStateForTest((s) => {
      s.area.actors.find((a) => a.id === s.player.actorId)!.hp = 1;
    });
  });
  for (let i = 0; i < 40 && (await layer(page)) !== 'end'; i++) {
    if ((await layer(page)) === 'narration') await page.keyboard.press('Escape');
    await page.keyboard.press('.');
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  const end = await page.evaluate(() => ({ layer: window.__anyworld!.ui.layer(), status: window.__anyworld!.controller?.session.state.status, reason: window.__anyworld!.controller?.session.state.endReason }));
  fact('death', end);
  await shot(page, 'western-death');
  const again = page.locator('button', { hasText: /same world again/i });
  if (await again.count()) {
    await again.click();
    await waitReady(page);
    await page.waitForTimeout(800);
    fact('death-restart', await page.evaluate(() => ({ layer: window.__anyworld!.ui.layer(), turn: window.__anyworld!.controller?.session.state.turn, hp: window.__anyworld!.controller?.session.player().hp })));
    await shot(page, 'western-restart');
  }
});
