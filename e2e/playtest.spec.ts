/**
 * Playtester round: plays every bundled fixture world in the real browser for a long stretch.
 * The explorer sim bot chooses what to do (it only picks legal actions), but every action that has
 * a key goes through the real keyboard so the UI paths are exercised; modal layers (narration,
 * level-up, dialogue, choice, trade) are answered with keys like a player would.
 * Screenshots: docs/progress/M2/playtest-r<ROUND>-*.png. Findings are written as JSON next to them
 * (playtest-r<ROUND>-<world>.json) so the report can quote numbers.
 * Run: PLAYTEST_ROUND=1 xvfb-run -a npx playwright test e2e/playtest.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROUND = process.env.PLAYTEST_ROUND ?? '1';
// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/playtest-r${ROUND}-${name}.png` });

const WORLDS = ['fixture-ship', 'fixture-teen', 'fixture-western', 'fixture-dream'] as const;
const KEY: Record<string, string> = { n: 'ArrowUp', s: 'ArrowDown', e: 'ArrowRight', w: 'ArrowLeft', nw: 'y', ne: 'u', sw: 'b', se: 'n' };

type Report = {
  world: string;
  seed: number;
  steps: number;
  result: string;
  turn: number;
  area: number;
  level: number;
  keyMismatch: string[];
  refused: string[];
  layers: Record<string, number>;
  actions: Record<string, number>;
  errors: string[];
  notes: string[];
  stuckAt: string[];
};

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

async function layer(page: Page): Promise<string> {
  return page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');
}

async function installBot(page: Page, seed: number) {
  await page.evaluate(async ([seed, root]) => {
    (window as unknown as { __ptRoot: string }).__ptRoot = root;
    const sim = await import('/@fs' + (window as unknown as { __ptRoot: string }).__ptRoot + '/src/engine/sim/index.ts');
    (window as unknown as { __pt: unknown }).__pt = { sim, bot: sim.botByName('explorer'), mem: sim.newMemory(seed) };
  }, [seed, process.cwd()] as const);
}

/** asks the bot what to do; returns the action and a snapshot to verify it */
async function decide(page: Page) {
  return page.evaluate(() => {
    const pt = (window as unknown as { __pt: { bot: { decide: Function }; mem: { lastInvalid: string | null } } }).__pt;
    const s = window.__anyworld!.controller!.session;
    const a = pt.bot.decide(s.state, s.world, pt.mem);
    const p = s.player();
    return { a, pos: { ...p.pos }, turn: s.state.turn, area: s.state.area.index, status: s.state.status, log: s.state.log.length };
  });
}

async function driveWorld(page: Page, world: string, seed: number, maxSteps: number, rep: Report, everyShot = 60) {
  await installBot(page, seed);
  const seenLayer = new Set<string>();
  let lastTurn = -1;
  let sameTurn = 0;
  for (let i = 0; i < maxSteps; i++) {
    const L = await layer(page);
    rep.layers[L] = (rep.layers[L] ?? 0) + 1;
    if (!seenLayer.has(L) && L !== 'game') {
      seenLayer.add(L);
      await page.waitForTimeout(400);
      await shot(page, `${world}-layer-${L}`);
    }
    if (L === 'end') break;
    if (L === 'narration') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
      continue;
    }
    if (L === 'levelup' || L === 'choice') {
      await page.keyboard.press('1');
      await page.waitForTimeout(150);
      if ((await layer(page)) === L) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
      }
      if ((await layer(page)) === L) rep.notes.push(`${L}: keys 1/Enter did not resolve it (step ${i})`);
      continue;
    }
    if (L === 'dialogue') {
      // take the first reply, then leave
      await page.keyboard.press('1');
      await page.waitForTimeout(200);
      if ((await layer(page)) === 'dialogue') await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      continue;
    }
    if (L === 'trade' || L === 'backpack' || L === 'rules' || L === 'help' || L === 'look' || L === 'target' || L === 'menu') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
      continue;
    }
    if (L !== 'game') {
      await page.waitForTimeout(200);
      continue;
    }
    const d = await decide(page);
    if (d.status !== 'playing') break;
    rep.actions[d.a.type] = (rep.actions[d.a.type] ?? 0) + 1;
    if (d.turn === lastTurn) {
      sameTurn++;
      if (sameTurn === 30) rep.stuckAt.push(`turn ${d.turn} area ${d.area} pos ${d.pos.x},${d.pos.y} last=${JSON.stringify(d.a)}`);
    } else sameTurn = 0;
    lastTurn = d.turn;
    if (sameTurn > 60) break;

    let viaKey: string | null = null;
    if (d.a.type === 'move') viaKey = KEY[d.a.dir];
    else if (d.a.type === 'wait') viaKey = '.';
    else if (d.a.type === 'pickup') viaKey = 'g';
    else if (d.a.type === 'transition') viaKey = '>';
    if (viaKey) {
      await page.keyboard.press(viaKey);
    } else {
      await page.evaluate((a) => window.__anyworld!.controller!.actNow(a), d.a);
    }
    await page.waitForTimeout(40);
    const after = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      return { pos: { ...s.player().pos }, turn: s.state.turn, area: s.state.area.index, logLen: s.state.log.length, log: s.state.log.slice(-3).map((l) => l.text) };
    });
    const moved = after.pos.x !== d.pos.x || after.pos.y !== d.pos.y;
    if (viaKey && d.a.type === 'move' && !moved && after.turn === d.turn && after.logLen === d.log && after.area === d.area) {
      if (rep.keyMismatch.length < 15) rep.keyMismatch.push(`step ${i} ${d.a.dir} via ${viaKey}: turn unchanged; log=${JSON.stringify(after.log)}`);
    }
    if (!viaKey && after.turn === d.turn && after.logLen === d.log && after.area === d.area && d.a.type !== 'choose_perk' && d.a.type !== 'choose_option') {
      if (rep.refused.length < 20) rep.refused.push(`step ${i} ${JSON.stringify(d.a)} log=${JSON.stringify(after.log.slice(-1))}`);
    }
    if (after.area !== d.area) {
      await page.waitForTimeout(900);
      await shot(page, `${world}-area${after.area}-arrive`);
    } else if (i % everyShot === 0) {
      await shot(page, `${world}-play-${String(i).padStart(4, '0')}`);
    }
    rep.steps = i + 1;
  }
  const fin = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    return { status: s.state.status, turn: s.state.turn, area: s.state.area.index, level: s.state.player.level, reason: s.state.endReason ?? '' };
  });
  rep.result = `${fin.status} ${fin.reason}`;
  rep.turn = fin.turn;
  rep.area = fin.area;
  rep.level = fin.level;
  await page.waitForTimeout(800);
  await shot(page, `${world}-zz-final`);
}

for (const [wi, world] of WORLDS.entries()) {
  test(`playtest ${world}`, async ({ page }) => {
    test.setTimeout(900_000);
    const seed = 11 + wi;
    const rep: Report = { world, seed, steps: 0, result: '', turn: 0, area: 0, level: 1, keyMismatch: [], refused: [], layers: {}, actions: {}, errors: [], notes: [], stuckAt: [] };
    page.on('console', (m) => {
      if (m.type() === 'error' && rep.errors.length < 30) rep.errors.push(m.text());
    });
    page.on('pageerror', (e) => rep.errors.push(String(e)));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pt-init')) {
        localStorage.clear();
        sessionStorage.setItem('pt-init', '1');
      }
    });
    await page.goto(`/?world=${world}&seed=${seed}`);
    await waitReady(page);
    await page.waitForTimeout(1500);
    await shot(page, `${world}-00-intro`);

    // play a first stretch, then reload mid-run and check the run resumes where it was
    await driveWorld(page, world, seed, 250, rep);
    const before = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      return { turn: s.state.turn, area: s.state.area.index, pos: s.player().pos, hp: s.player().hp, inv: s.state.player.slots.map((x) => x?.defId ?? null) };
    });
    if (before && (await page.evaluate(() => window.__anyworld!.controller!.session.state.status)) === 'playing') {
      await page.reload();
      await waitReady(page);
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => {
        const c = window.__anyworld?.controller;
        if (!c) return null;
        const s = c.session;
        return { turn: s.state.turn, area: s.state.area.index, pos: s.player().pos, hp: s.player().hp, inv: s.state.player.slots.map((x) => x?.defId ?? null), url: location.href, layer: window.__anyworld!.ui.layer() };
      });
      await shot(page, `${world}-reload`);
      if (!after) rep.notes.push('reload: no controller after reload (start screen?)');
      else if (after.turn !== before.turn || after.area !== before.area || after.pos.x !== before.pos.x || after.pos.y !== before.pos.y || after.hp !== before.hp)
        rep.notes.push(`reload mismatch: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      else rep.notes.push(`reload ok at turn ${after.turn} (layer after reload: ${after.layer})`);
      if (after) await driveWorld(page, world, seed + 1000, 2500, rep, 150);
    }
    writeFileSync(`${OUT}/playtest-r${ROUND}-${world}.json`, JSON.stringify(rep, null, 2));
    expect(rep.steps).toBeGreaterThan(0);
  });
}
