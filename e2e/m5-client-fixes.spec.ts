/**
 * M5 client fixes in the browser (issues/M5-*.md): keyboard zoom direction, a second run's prologue,
 * the long-press card closing on the next press, Wait always reachable on a narrow phone, the
 * dialogue sheet's buttons and toasts on phones, and the notice while the WebGL context is lost.
 * Screenshots: docs/archive/progress/M5/client-fix-*.png
 *
 * Run: xvfb-run -a npx playwright test e2e/m5-client-fixes.spec.ts
 * M5_BASE=http://localhost:<port> points it at another dev server.
 */
import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// review screenshots go to test-results; SHOTS_TO_DOCS=1 writes the committed milestone copies
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M5' : 'test-results/shots/m5-client-fixes';
mkdirSync(OUT, { recursive: true });
if (process.env.M5_BASE) test.use({ baseURL: process.env.M5_BASE });

type Device = (typeof devices)[string];
function phone(name: string): Omit<Device, 'defaultBrowserType'> {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/client-fix-${name}.png` });
const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|WebGL|GL_|context lost/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** clean storage once per page, English UI, and no Vite HMR reloads under the test */
async function fresh(page: Page, lang = 'en'): Promise<void> {
  await page.addInitScript((l) => {
    if (!sessionStorage.getItem('m5-init')) {
      try {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', l);
      } catch {
        /* storage blocked */
      }
      sessionStorage.setItem('m5-init', '1');
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

async function openWorld(page: Page, world: string, seed: number): Promise<void> {
  await page.goto(`/?world=${world}&seed=${seed}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__anyworld?.controller != null, null, { timeout: 60000 });
  await page.waitForTimeout(800);
}

/** prologue (finish typing, close) and the how-to-play card, by keyboard or touch */
async function intoGame(page: Page, touch = false): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const L = await layer(page);
    if (L === 'narration') {
      if (touch) await page.locator('.aw-narration:not([hidden]) .aw-narr-btn').tap();
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
      continue;
    }
    const ok = page.locator('.aw-onboard:not([hidden]) .aw-onboard-ok');
    if (await ok.isVisible().catch(() => false)) {
      if (touch) await ok.tap();
      else await ok.click();
      await page.waitForTimeout(250);
      continue;
    }
    break;
  }
}

const camDist = (page: Page) => page.evaluate(() => (window.__anyworld!.renderer as unknown as { rig: { distTarget: number } }).rig.distTarget);

test.describe('desktop', () => {
  test('"+" zooms in and "-" zooms out (issues/M5-zoom-keys-inverted.md)', async ({ page }) => {
    await fresh(page);
    await openWorld(page, 'fixture-western', 3);
    await intoGame(page);
    const d0 = await camDist(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('+');
    await page.waitForTimeout(300);
    const dPlus = await camDist(page);
    for (let i = 0; i < 6; i++) await page.keyboard.press('-');
    await page.waitForTimeout(300);
    const dMinus = await camDist(page);
    expect(dPlus, `"+" brings the camera closer (${d0} → ${dPlus})`).toBeLessThan(d0);
    expect(dMinus, `"-" moves it away (${dPlus} → ${dMinus})`).toBeGreaterThan(dPlus);
  });

  test('a second world started from the end screen opens with its prologue, then the how-to-play card (issues/M5-second-run-skips-prologue.md)', async ({ page }) => {
    const errors = watchErrors(page);
    await fresh(page);
    await page.goto('/');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.locator('.aw-demo[data-world="fixture-western"]').click();
    await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
    await page.waitForTimeout(1000);
    expect(await layer(page)).toBe('narration');
    await intoGame(page);
    expect(await layer(page)).toBe('game');
    await page.evaluate(() =>
      window.__anyworld!.controller!.setStateForTest((s) => {
        (s as { status: string }).status = 'lost';
      }),
    );
    await expect.poll(() => layer(page)).toBe('end');
    await page.getByRole('button', { name: 'New world' }).click();
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => document.querySelector('.aw-start')?.scrollTop ?? -1), 'the start screen opens at the top').toBe(0);
    await page.locator('.aw-demo[data-world="fixture-teen"]').click();
    await page.waitForFunction(() => window.__anyworld?.controller?.session.worldId === 'fixture-teen', null, { timeout: 60000 });
    await page.waitForTimeout(1000);
    await shot(page, 'second-run-prologue');
    expect(await layer(page), 'the second run opens on its prologue').toBe('narration');
    expect(await page.locator('.aw-narration').innerText()).toContain('Lowmoor');
    // closing the prologue shows how to play at once, before any move
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    if ((await layer(page)) === 'narration') await page.keyboard.press('Enter');
    await expect(page.locator('.aw-onboard')).toBeVisible();
    // the verb lines carry their keys for a keyboard/mouse player
    await expect(page.locator('.aw-onboard .aw-onboard-verbkey').first()).toBeVisible();
    await shot(page, 'second-run-onboarding');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/** moves an NPC of the area next to the player (a free floor tile) and returns its id */
async function npcNextToPlayer(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    let id: string | null = null;
    await c.setStateForTest((s) => {
      const me = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
      const defs = new Map(c.session.world.actors.map((d) => [d.id, d]));
      const npc = s.area.actors.find((a) => a.id !== me.id && a.hp > 0 && defs.get(a.defId)?.npc && a.faction !== 'hostile');
      if (!npc) return;
      const m = s.area.map;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = me.pos.x + dx;
        const y = me.pos.y + dy;
        const t = m.tiles[y * m.width + x];
        if (!t || (t.kind !== 'floor' && t.kind !== 'start')) continue;
        if (s.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
        npc.pos = { x, y };
        id = npc.id;
        return;
      }
    });
    return id;
  });
}

test.describe('Pixel 7 portrait', () => {
  test.use(phone('Pixel 7'));

  test('Wait stays on screen next to a long "Talk to <name, title>" (issues/M5-phone-talk-pushes-wait.md)', async ({ page }) => {
    await fresh(page);
    await openWorld(page, 'detective-sugar-hotel', 13);
    await intoGame(page, true);
    expect(await layer(page)).toBe('game');
    const id = await npcNextToPlayer(page);
    expect(id, 'an NPC to talk to').not.toBeNull();
    await page.waitForTimeout(300);
    const talk = page.locator('.aw-ctx .aw-ctx-btn[data-action="talk"]');
    await expect(talk).toBeVisible();
    expect(await talk.innerText()).not.toContain(',');
    const vw = page.viewportSize()!.width;
    const wait = await page.locator('.aw-ctx .aw-ctx-btn[data-action="wait"]').boundingBox();
    expect(wait, 'the Wait button').not.toBeNull();
    expect(wait!.x + wait!.width, `Wait inside the ${vw}px screen`).toBeLessThanOrEqual(vw + 1);
    expect(wait!.x).toBeGreaterThanOrEqual(-1);
    await shot(page, 'pixel7-ctx');
    // a tap on it passes a turn
    const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    await page.locator('.aw-ctx .aw-ctx-btn[data-action="wait"]').tap();
    await expect.poll(() => page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(t0);
  });
});

async function longPress(cdp: CDPSession, x: number, y: number, ms = 700): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await new Promise((r) => setTimeout(r, ms));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('iPhone 15 landscape', () => {
  test.use(phone('iPhone 15 landscape'));

  test('the long-press card closes on the next button press; the dialogue sheet keeps its buttons on screen; toasts avoid sheets', async ({ page }) => {
    const errors = watchErrors(page);
    await fresh(page);
    await openWorld(page, 'deep-sea-whale-fall', 8);
    await intoGame(page, true);
    expect(await layer(page)).toBe('game');
    const cdp = await page.context().newCDPSession(page);

    // long-press the player: the inspect card; a tap on Wait closes it (issues/M5-inspect-card-lingers.md)
    const pt = await page.evaluate(() => {
      const app = window.__anyworld!;
      return app.renderer!.tileToScreen(app.controller!.session.player().pos);
    });
    await longPress(cdp, pt.x, pt.y);
    await expect(page.locator('.aw-tooltip.is-visible')).toBeVisible();
    await page.locator('.aw-ctx .aw-ctx-btn[data-action="wait"]').tap();
    await page.waitForTimeout(300);
    await expect(page.locator('.aw-tooltip.is-visible')).toHaveCount(0);

    // again, then a dialogue opens: the card must not stay on top of the sheet
    await longPress(cdp, pt.x, pt.y);
    await expect(page.locator('.aw-tooltip.is-visible')).toBeVisible();
    const id = await npcNextToPlayer(page);
    expect(id, 'an NPC to talk to').not.toBeNull();
    await page.evaluate((npc) => window.__anyworld!.controller!.onAction({ type: 'talk', targetId: npc! }), id);
    await expect.poll(() => layer(page)).toBe('dialogue');
    await expect(page.locator('.aw-tooltip.is-visible')).toHaveCount(0);

    // the sheet's Leave button is fully on screen without scrolling (issues/M5-landscape-dialogue-buttons-clipped.md)
    await page.waitForTimeout(500);
    const vp = page.viewportSize()!;
    const leave = await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost').boundingBox();
    expect(leave).not.toBeNull();
    expect(leave!.y + leave!.height, `Leave inside the ${vp.height}px screen`).toBeLessThanOrEqual(vp.height + 1);

    // a toast while the sheet is open sits above it, not on it (issues/M5-toasts-over-sheets.md)
    await page.evaluate(() => window.__anyworld!.ui.toast('No known way there.', 'warn'));
    await page.waitForTimeout(300);
    const toast = await page.locator('.aw-toast').last().boundingBox();
    const card = await page.locator('.aw-dialogue').boundingBox();
    expect(toast && card).toBeTruthy();
    expect(toast!.y + toast!.height, 'toast above the sheet').toBeLessThanOrEqual(card!.y + 1);
    await shot(page, 'iphone15-landscape-dialogue');
    await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost').tap();
    await expect.poll(() => layer(page)).toBe('game');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a lost WebGL context shows a notice and holds play until the map is back (issues/M5-webgl-context-lost-silent.md)', async ({ page }) => {
    await fresh(page);
    await openWorld(page, 'fixture-dream', 4);
    await intoGame(page, true);
    expect(await layer(page)).toBe('game');
    const ok = await page.evaluate(() => {
      const c = document.querySelector('#game-canvas canvas') as HTMLCanvasElement | null;
      const gl = (c?.getContext('webgl2') ?? c?.getContext('webgl')) as WebGLRenderingContext | null;
      const ext = gl?.getExtension('WEBGL_lose_context');
      (window as unknown as { __lose: unknown }).__lose = ext;
      ext?.loseContext();
      return !!ext;
    });
    test.skip(!ok, 'WEBGL_lose_context is not available');
    await expect(page.locator('.aw-gfx-lost')).toBeVisible();
    await shot(page, 'iphone15-landscape-gfx-lost');
    const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    // the Wait button is behind the notice: a tap there passes no turn
    const wait = await page.locator('.aw-ctx .aw-ctx-btn[data-action="wait"]').boundingBox();
    if (wait) await page.touchscreen.tap(wait.x + wait.width / 2, wait.y + wait.height / 2);
    await page.keyboard.press('.');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBe(t0);
    // the reload offer appears if the browser takes too long
    await expect(page.locator('.aw-gfx-reload')).toBeVisible({ timeout: 8000 });
    await page.evaluate(() => (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext());
    await expect(page.locator('.aw-gfx-lost')).toBeHidden({ timeout: 10000 });
    await page.locator('.aw-ctx .aw-ctx-btn[data-action="wait"]').tap();
    await expect.poll(() => page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(t0);
  });
});
