/**
 * The playable game at `/` (issues/M1-missing-main-controller.md): the start screen lists the
 * recorded worlds, a demo starts a run, a few turns are played with the keyboard and mouse, and the
 * end screen leads back into a new run. Screenshots go to docs/archive/progress/M2/play-*.png.
 * Run: xvfb-run -a npx playwright test e2e/play.spec.ts
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()} ${r.url()}`);
  });
  return errors;
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

type Snap = { turn: number; x: number; y: number; layer: string; screen: string; status: string; area: number };

function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const s = app.controller!.session.state;
    const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
    return { turn: s.turn, x: p.pos.x, y: p.pos.y, layer: app.ui.layer(), screen: document.getElementById('ui-root')!.dataset.screen ?? '', status: s.status, area: s.area.index };
  });
}

/** dismiss the intro narration if it is up */
async function skipNarration(page: Page) {
  for (let i = 0; i < 3; i++) {
    if ((await snap(page)).layer !== 'narration') return;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  }
}

test.describe.configure({ mode: 'serial' });

test('start screen lists the demo worlds and a demo starts a playable run', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('.aw-start')).toBeVisible();
  const demos = page.locator('.aw-demo');
  expect(await demos.count()).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: `${OUT}/play-00-start.png` });

  await demos.first().click();
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  await waitReady(page);
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await expect(page.locator('.aw-game')).toBeVisible();
  await page.screenshot({ path: `${OUT}/play-01-intro.png` });
  await skipNarration(page);

  // a few turns with the keyboard: waits always succeed, moves when the way is free
  const t0 = (await snap(page)).turn;
  await page.keyboard.press('.');
  await page.waitForTimeout(150);
  for (const k of ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'l', 'k']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(180);
  }
  const s1 = await snap(page);
  expect(s1.turn).toBeGreaterThan(t0);
  expect(s1.status).toBe('playing');
  await page.screenshot({ path: `${OUT}/play-02-turns.png` });

  // the run was autosaved
  const saved = await page.evaluate(() => localStorage.getItem('anyworld.save.v1'));
  expect(saved).toBeTruthy();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('direct world link, camera-relative keys, mouse travel and backpack', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?world=fixture-ship&seed=3');
  await waitReady(page);
  await skipNarration(page);

  // screen-up follows the camera: after each rotation, ArrowUp moves the player up on screen
  let moved = 0;
  for (let rot = 0; rot < 4; rot++) {
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.cameraStep)).toBe(rot);
    const before = await page.evaluate(() => {
      const app = window.__anyworld!;
      const s = app.controller!.session.state;
      const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
      return { pos: { ...p.pos }, screen: app.renderer!.tileToScreen(p.pos) };
    });
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(250);
    const after = await snap(page);
    if (after.x !== before.pos.x || after.y !== before.pos.y) {
      moved++;
      const screenAfter = await page.evaluate(([x, y]) => window.__anyworld!.renderer!.tileToScreen({ x, y }), [after.x, after.y]);
      expect(screenAfter.y).toBeLessThan(before.screen.y);
    }
    await page.keyboard.press('e');
    await page.waitForTimeout(400);
  }
  expect(moved).toBeGreaterThan(0);
  await page.screenshot({ path: `${OUT}/play-10-rotated.png` });

  // click-to-travel: click a visible floor tile a few steps away
  const dest = await page.evaluate(() => {
    const app = window.__anyworld!;
    const s = app.controller!.session.state;
    const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
    const m = s.area.map;
    const seen = s.players[s.party[0]].seen as ArrayLike<number>;
    let best: { x: number; y: number } | null = null;
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) {
        const t = m.tiles[y * m.width + x];
        const d = Math.max(Math.abs(x - p.pos.x), Math.abs(y - p.pos.y));
        if (seen[y * m.width + x] === 2 && (t.kind === 'floor' || t.kind === 'start') && d >= 2 && d <= 4 && !s.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) {
          if (!best) best = { x, y };
        }
      }
    if (!best) return null;
    return { tile: best, screen: app.renderer!.tileToScreen(best) };
  });
  if (dest) {
    const before = await snap(page);
    await page.mouse.click(dest.screen.x, dest.screen.y);
    await page.waitForTimeout(1500);
    const after = await snap(page);
    expect(after.turn).toBeGreaterThan(before.turn);
    expect(after.x !== before.x || after.y !== before.y).toBe(true);
  }

  // backpack opens and closes
  await page.keyboard.press('i');
  await page.waitForTimeout(200);
  expect((await snap(page)).layer).toBe('backpack');
  await page.screenshot({ path: `${OUT}/play-11-backpack.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect((await snap(page)).layer).not.toBe('backpack');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('talking to an NPC opens the dialogue and leaving closes it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?world=fixture-western&seed=1');
  await waitReady(page);
  await skipNarration(page);
  // put the player next to an NPC (test shortcut), then press t
  const ok = await page.evaluate(() => {
    const app = window.__anyworld!;
    const ses = app.controller!.session;
    const s = structuredClone(ses.state);
    const npc = s.area.actors.find((a) => ses.world.actors.find((d) => d.id === a.defId)?.npc && a.faction !== 'hostile');
    if (!npc) return false;
    const m = s.area.map;
    const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = npc.pos.x + dx;
      const y = npc.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (t && (t.kind === 'floor' || t.kind === 'start') && !s.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) {
        p.pos = { x, y };
        ses.state = s;
        app.controller!.onAction({ type: 'wait' });
        return true;
      }
    }
    return false;
  });
  expect(ok).toBe(true);
  await page.keyboard.press('t');
  await page.waitForTimeout(300);
  expect((await snap(page)).layer).toBe('dialogue');
  await expect(page.locator('.aw-dialogue, [aria-label*="ialogue"]').first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/play-20-dialogue.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect((await snap(page)).layer).not.toBe('dialogue');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the end screen offers the same world again', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?world=fixture-teen&seed=5');
  await waitReady(page);
  await skipNarration(page);
  await page.evaluate(() => {
    const app = window.__anyworld!;
    const ses = app.controller!.session;
    ses.state = { ...ses.state, status: 'lost', endReason: 'e2e' };
    app.controller!.render();
  });
  await expect(page.locator('.aw-end')).toBeVisible();
  await page.screenshot({ path: `${OUT}/play-30-end.png` });
  await page.getByRole('button', { name: 'Same world again' }).click();
  await page.waitForFunction(() => window.__anyworld?.controller?.session.state.status === 'playing', null, { timeout: 60000 });
  await waitReady(page);
  const s = await snap(page);
  expect(s.screen).toBe('game');
  expect(s.turn).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
