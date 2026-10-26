/**
 * Playtester round 3: earning currency in real play and spending it at a trader through the UI.
 * The explorer sim bot plays each fixture for a stretch (moves/waits/pickups by keyboard); the spec
 * records every currency change and where it came from (log line). Then the player is put next to a
 * trader of the current area (or the world's first trader is spawned beside them), the trade modal
 * is opened from the dialogue with the mouse, the cheapest affordable offer is bought and one item
 * is sold back.
 * Screenshots: docs/progress/M2/playtest-r<ROUND>-econ-*.png; facts: playtest-r<ROUND>-econ.json.
 * Run: PLAYTEST_ROUND=3 xvfb-run -a npx playwright test e2e/playtest-r3.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const ROUND = process.env.PLAYTEST_ROUND ?? '3';
// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/playtest-r${ROUND}-econ-${name}.png` });
const FACTS = `${OUT}/playtest-r${ROUND}-econ.json`;
function fact(key: string, value: unknown) {
  const f = existsSync(FACTS) ? JSON.parse(readFileSync(FACTS, 'utf8')) : {};
  f[key] = value;
  writeFileSync(FACTS, JSON.stringify(f, null, 2));
}
const KEY: Record<string, string> = { n: 'ArrowUp', s: 'ArrowDown', e: 'ArrowRight', w: 'ArrowLeft', nw: 'y', ne: 'u', sw: 'b', se: 'n' };
const WORLDS = ['fixture-ship', 'fixture-teen', 'fixture-western', 'fixture-dream'] as const;

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');
async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(400);
}

async function play(page: Page, seed: number, steps: number) {
  await page.evaluate(async ([seed, root]) => {
    const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
    (window as unknown as { __pt: unknown }).__pt = { bot: sim.botByName('explorer'), mem: sim.newMemory(seed) };
  }, [seed, process.cwd()] as const);
  const gains: { turn: number; area: number; delta: number; log: string[] }[] = [];
  const labelPeaks: number[] = [];
  for (let i = 0; i < steps; i++) {
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
      const pt = (window as unknown as { __pt: { bot: { decide: Function }; mem: unknown } }).__pt;
      const s = window.__anyworld!.controller!.session;
      return { a: pt.bot.decide(s.state, s.world, pt.mem), cur: s.state.purse, status: s.state.status };
    });
    if (d.status !== 'playing') break;
    const k = d.a.type === 'move' ? KEY[d.a.dir] : d.a.type === 'wait' ? '.' : d.a.type === 'pickup' ? 'g' : d.a.type === 'transition' ? '>' : null;
    if (k) await page.keyboard.press(k);
    else await page.evaluate((a) => window.__anyworld!.controller!.actNow(a), d.a);
    await page.waitForTimeout(35);
    const after = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      return { cur: s.state.purse, turn: s.state.turn, area: s.state.area.index, log: s.state.log.slice(-4).map((l) => l.text) };
    });
    if (after.cur !== d.cur) gains.push({ turn: after.turn, area: after.area, delta: after.cur - d.cur, log: after.log });
    if (i % 25 === 0) {
      // floating text labels currently over the board (status names, damage numbers)
      labelPeaks.push(
        await page.evaluate(() => {
          const r = window.__anyworld!.renderer as unknown as { vfx?: { group: { children: { type: string; visible: boolean }[] } } } | null;
          return r?.vfx ? r.vfx.group.children.filter((c) => c.type === 'Sprite' && c.visible).length : -1;
        }),
      );
    }
  }
  return { gains, labelPeaks };
}

for (const [wi, world] of WORLDS.entries()) {
  test(`economy ${world}: earn in play, buy and sell at a trader`, async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && errors.length < 20) errors.push(m.text());
    });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pt-init')) {
        localStorage.clear();
        sessionStorage.setItem('pt-init', '1');
      }
    });
    const seed = 301 + wi;
    await page.goto(`/?world=${world}&seed=${seed}`);
    await waitReady(page);
    const start = await page.evaluate(() => window.__anyworld!.controller!.session.state.purse);
    const run = await play(page, seed, 700);
    const mid = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      return { cur: s.state.purse, status: s.state.status, area: s.state.area.index, turn: s.state.turn, hud: document.querySelector('.aw-hud')?.textContent?.match(/\d+\s*[a-z ]*$/i)?.[0] ?? null };
    });
    await shot(page, `${world}-after-play`);

    // a fresh run if the bot died, so trade can still be tested with the earned amount carried over by hand
    if (mid.status !== 'playing') {
      await page.evaluate(() => localStorage.clear());
      await page.goto(`/?world=${world}&seed=${seed + 50}`);
      await waitReady(page);
      await page.evaluate(async (cur) => {
        await window.__anyworld!.controller!.setStateForTest((s) => {
          s.purse = cur;
        });
      }, mid.cur);
    }
    for (let i = 0; i < 4 && (await layer(page)) !== 'game'; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }

    // stand next to a trader (one in this area, else spawn the world's first trader beside us)
    const trader = await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      const w = c.session.world;
      const traderIds = w.actors.filter((a) => a.npc && ((a.npc as { stock?: unknown[] }).stock?.length ?? 0) > 0).map((a) => a.id);
      let t = c.session.state.area.actors.find((a) => traderIds.includes(a.defId));
      let spawned = false;
      if (!t) {
        c.gmNow([{ type: 'spawn', actor: traderIds[0], count: 1, near: 'player' } as never]);
        t = c.session.state.area.actors.find((a) => traderIds.includes(a.defId));
        spawned = true;
      }
      if (!t) return { traderIds, found: null, spawned };
      const m = c.session.state.area.map;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = t.pos.x + dx;
        const y = t.pos.y + dy;
        const tile = m.tiles[y * m.width + x];
        if (!tile || !['floor', 'start', 'door_open'].includes(tile.kind)) continue;
        if (c.session.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
        await c.setStateForTest((s) => {
          s.area.actors = s.area.actors.filter((a) => a.id === s.players[s.party[0]].actorId || a.faction !== 'hostile');
          s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!.pos = { x, y };
        });
        c.actNow({ type: 'wait' });
        return { traderIds, found: t.defId, spawned };
      }
      return { traderIds, found: t.defId, spawned, noFreeTile: true };
    });
    await page.waitForTimeout(500);
    for (let i = 0; i < 4 && (await layer(page)) === 'narration'; i++) await page.keyboard.press('Escape');
    await page.keyboard.press('t');
    await page.waitForTimeout(600);
    const talkLayer = await layer(page);
    await shot(page, `${world}-talk`);
    const tradeBtn = page.locator('.aw-dialogue button', { hasText: /^Trade/ }).first();
    if (talkLayer === 'dialogue' && (await tradeBtn.count())) {
      await tradeBtn.click();
      await page.waitForTimeout(500);
    }
    const tradeLayer = await layer(page);
    await shot(page, `${world}-trade`);
    const rows = await page.locator('.aw-trade .aw-trade-row').evaluateAll((els) =>
      els.map((e) => ({ text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim(), disabled: (e as HTMLButtonElement).disabled })),
    );
    const cur0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.purse);
    const slots0 = await page.evaluate(() => window.__anyworld!.controller!.session.me.slots.filter(Boolean).length);
    const buyRow = page.locator('.aw-trade .aw-trade-row:not([disabled])', { hasText: /Buy/i }).first();
    let bought = false;
    if (await buyRow.count()) {
      await buyRow.click();
      await page.waitForTimeout(500);
      bought = true;
    }
    const cur1 = await page.evaluate(() => window.__anyworld!.controller!.session.state.purse);
    const slots1 = await page.evaluate(() => window.__anyworld!.controller!.session.me.slots.filter(Boolean).length);
    await shot(page, `${world}-bought`);
    const sellRow = page.locator('.aw-trade .aw-trade-row:not([disabled])', { hasText: /Sell/i }).first();
    let sold = false;
    if ((await layer(page)) === 'trade' && (await sellRow.count())) {
      await sellRow.click();
      await page.waitForTimeout(500);
      sold = true;
    }
    const cur2 = await page.evaluate(() => window.__anyworld!.controller!.session.state.purse);
    const tradeLog = await page.evaluate(() => window.__anyworld!.controller!.session.state.log.slice(-5).map((l) => l.text));
    await shot(page, `${world}-sold`);
    fact(world, { start, earned: run.gains, labelPeaks: run.labelPeaks, mid, trader, talkLayer, tradeLayer, rows, cur0, bought, cur1, slots0, slots1, sold, cur2, tradeLog, errors });
    expect(errors).toEqual([]);
  });
}

test('dream: floating status labels while walking fast', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('pt-init')) {
      localStorage.clear();
      sessionStorage.setItem('pt-init', '1');
    }
  });
  await page.goto('/?world=fixture-dream&seed=77');
  await waitReady(page);
  for (let i = 0; i < 6 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  // visible text sprites (depthTest off) and where they are on screen relative to the player
  const probe = () =>
    page.evaluate(() => {
      const r = window.__anyworld!.renderer as unknown as { vfx: { group: { children: { type: string; visible: boolean; material: { depthTest: boolean; opacity: number } }[] } } };
      return r.vfx.group.children.filter((c) => c.type === 'Sprite' && c.visible && c.material.depthTest === false && c.material.opacity > 0.3).length;
    });
  const samples: number[] = [];
  for (let step = 0; step < 8; step++) {
    await page.evaluate(() =>
      window.__anyworld!.controller!.gmNow([
        { type: 'effect', target: 'player', effects: [{ type: 'apply_status', status: 'smeared', duration: 2 }, { type: 'apply_status', status: 'vivid', duration: 2 }, { type: 'apply_status', status: 'wet-on-wet', duration: 2 }] } as never,
      ]),
    );
    const free = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      const p = s.player().pos;
      for (const [k, dx, dy] of [['ArrowRight', 1, 0], ['ArrowLeft', -1, 0], ['ArrowDown', 0, 1], ['ArrowUp', 0, -1]] as const) {
        const pv = s.preview({ x: p.x + dx, y: p.y + dy });
        if (pv?.kind === 'walk') return k;
      }
      return '.';
    });
    await page.keyboard.press(free);
    await page.waitForTimeout(90);
    samples.push(await probe());
    if (step === 4) await shot(page, 'dream-status-labels');
  }
  await page.waitForTimeout(250);
  samples.push(await probe());
  await shot(page, 'dream-status-labels-after');
  fact('status-labels', { samples, max: Math.max(...samples) });
});
