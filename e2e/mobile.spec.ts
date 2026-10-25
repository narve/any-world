/**
 * M4 mobile & responsive (DESIGN §6, §6b): phones in portrait and landscape play a world with TOUCH
 * ONLY. The explorer sim bot decides what to do and every decision is carried out with taps: tap a
 * tile to walk (path-walk), tap an adjacent actor to attack / talk, the context buttons (pick up,
 * move on, talk, wait, search), the quick slots (and a tap on the target), bottom sheets (backpack,
 * rules, log, goal), long-press inspect, pinch zoom and the rotate buttons. Nothing is sent through
 * the keyboard or the automation handle; the handle is only read (state, screen positions).
 *
 * Along the way the layout is checked: the key overlay elements are inside the viewport and do not
 * overlap each other, tap targets are ≥ 44 px, the page never scrolls sideways, sheets fit on screen,
 * the renderer got viewport insets, and the console stays free of errors.
 * Screenshots: docs/progress/M4/mobile-<device>-*.png
 *
 * Run: xvfb-run -a npx playwright test e2e/mobile.spec.ts
 * MOBILE_BASE=http://localhost:<port> points it at another dev server (no HMR reloads mid-run).
 * MOBILE_TURNS=<n> changes the number of bot decisions per device (default 260).
 */
import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M4' : 'test-results/shots/M4';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.MOBILE_BASE;
const TURNS = Number(process.env.MOBILE_TURNS ?? 260);
if (BASE) test.use({ baseURL: BASE });
// a control that cannot be tapped is a layout bug: fail with the reason instead of waiting out the test
test.use({ actionTimeout: 10000 });

type Device = (typeof devices)[string];
/** a Playwright device descriptor without the browser choice (this sandbox runs headed chromium) */
function phone(name: string): Omit<Device, 'defaultBrowserType'> {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

const CASES: { id: string; device: string; world: string; seed: number; lang: string }[] = [
  { id: 'iphone13-portrait', device: 'iPhone 13', world: 'fixture-teen', seed: 7, lang: 'en' },
  { id: 'iphone13-landscape', device: 'iPhone 13 landscape', world: 'fixture-ship', seed: 5, lang: 'en' },
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'nb-russetid-bussen', seed: 3, lang: 'nb' },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'fixture-dream', seed: 4, lang: 'en' },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'fixture-western', seed: 9, lang: 'en' },
  { id: 'pixel7-landscape', device: 'Pixel 7 landscape', world: 'fixture-teen', seed: 12, lang: 'en' },
];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

/** the overlay elements that share the screen with the map during play */
const KEY_ELEMENTS: Record<string, string> = {
  hud: '.aw-hud',
  rules: '.aw-rules-badge',
  strip: '.aw-strip',
  goal: '.aw-goal',
  banner: '.aw-mode-banner',
  log: '.aw-log',
  ctx: '.aw-ctx',
  tools: '.aw-hotbar-tools',
  slots: '.aw-hotbar-slots',
  camera: '.aw-map-tools',
};

interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** visible boxes of the key elements, the viewport and the page's scroll width */
async function measure(page: Page) {
  return page.evaluate((sel) => {
    const vis = (el: Element | null): el is HTMLElement => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || (el as HTMLElement).closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const boxes: { name: string; left: number; top: number; right: number; bottom: number }[] = [];
    for (const [name, s] of Object.entries(sel)) {
      const el = document.querySelector(`.aw-game ${s}`);
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      boxes.push({ name, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    const small: string[] = [];
    const targets = document.querySelectorAll('.aw-game :is(.aw-hotbar .aw-slot, .aw-ctx-btn, .aw-hotbar-tools button, .aw-map-btn, .aw-rules-badge, .aw-goal-head, .aw-log)');
    for (const el of Array.from(targets)) {
      if (!vis(el)) continue;
      // layout size: a button being pressed is scaled down for a moment, that is not its size
      const w = (el as HTMLElement).offsetWidth;
      const hgt = (el as HTMLElement).offsetHeight;
      if (w < 43.5 || hgt < 43.5) small.push(`${el.className} ${w}x${hgt}`);
    }
    // nothing pokes past the screen's sides (the context bar scrolls inside itself)
    const wide: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.aw-game *'))) {
      if (el.offsetParent === null || el.closest('.aw-ctx')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) wide.push(`${String(el.className)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return {
      boxes,
      small,
      wide,
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      layout: document.getElementById('ui-root')?.dataset.layout ?? '',
    };
  }, KEY_ELEMENTS);
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? Math.min(w, h) : 0;
}

/** layout invariants for the play screen */
async function checkLayout(page: Page, where: string, layout: RegExp = /^phone-/): Promise<void> {
  const m = await measure(page);
  expect(m.layout, `${where}: layout`).toMatch(layout);
  expect(m.scrollW, `${where}: no horizontal scroll`).toBeLessThanOrEqual(m.vw + 1);
  for (const b of m.boxes) {
    expect(b.left >= -1 && b.top >= -1 && b.right <= m.vw + 1 && b.bottom <= m.vh + 1, `${where}: ${b.name} inside the viewport ${JSON.stringify(b)} in ${m.vw}x${m.vh}`).toBe(true);
  }
  for (let i = 0; i < m.boxes.length; i++) {
    for (let j = i + 1; j < m.boxes.length; j++) {
      const a = m.boxes[i];
      const b = m.boxes[j];
      expect(overlap(a, b), `${where}: ${a.name} overlaps ${b.name} ${JSON.stringify([a, b])}`).toBeLessThanOrEqual(1);
    }
  }
  expect(m.small, `${where}: tap targets ≥ 44 px`).toEqual([]);
  expect(m.wide, `${where}: elements past the screen edge`).toEqual([]);
}

/** an open bottom sheet / modal card fits the viewport */
async function checkSheet(page: Page, selector: string, where: string): Promise<void> {
  // let the slide-in finish (slow software-GL frames stretch it)
  await page
    .locator(selector)
    .first()
    .evaluate((el) =>
      Promise.race([
        Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1500)),
      ]),
    )
    .catch(() => undefined);
  const r = await page.locator(selector).first().boundingBox();
  expect(r, `${where}: ${selector} shown`).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(r!.x >= -1 && r!.y >= -1 && r!.x + r!.width <= vp.width + 1 && r!.y + r!.height <= vp.height + 1, `${where}: ${selector} inside the viewport ${JSON.stringify(r)}`).toBe(true);
}

/** screen point of a tile, and whether a tap there reaches the map (not a panel) */
async function tilePoint(page: Page, pos: { x: number; y: number }, actorId?: string) {
  return page.evaluate(
    ([p, id]) => {
      const app = window.__anyworld!;
      const r = app.renderer!;
      const at = (id && r.actorScreen(id as string, 0.45)) || r.tileToScreen(p as { x: number; y: number });
      const el = document.elementFromPoint(at.x, at.y);
      const onMap = !!el && !!el.closest('#game-canvas') && at.x > 2 && at.y > 2 && at.x < innerWidth - 2 && at.y < innerHeight - 2;
      const hit = onMap ? r.pick(at.x, at.y) : null;
      return { x: at.x, y: at.y, onMap, hits: !!hit && hit.x === (p as { x: number }).x && hit.y === (p as { y: number }).y };
    },
    [pos, actorId ?? null] as const,
  );
}

async function tapCtx(page: Page, action: string): Promise<boolean> {
  const b = page.locator(`.aw-ctx:not([hidden]) .aw-ctx-btn[data-action="${action}"]`);
  if (!(await b.count()) || !(await b.first().isVisible())) return false;
  await b.first().scrollIntoViewIfNeeded().catch(() => undefined);
  // a button that cannot be reached by touch is a layout bug: fail fast with the reason. A button
  // that went away meanwhile (the turn changed what is possible) is not.
  try {
    await b.first().tap({ timeout: 8000 });
  } catch (e) {
    if (await b.count()) throw e;
    return false;
  }
  return true;
}

/** taps through the prologue narration and the onboarding card */
async function clearIntro(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const narr = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (await narr.isVisible().catch(() => false)) {
      await narr.tap();
      await page.waitForTimeout(250);
      continue;
    }
    const ok = page.locator('.aw-onboard:not([hidden]) .aw-onboard-ok');
    if (await ok.isVisible().catch(() => false)) {
      await ok.tap();
      await page.waitForTimeout(250);
      continue;
    }
    break;
  }
}

async function longPress(cdp: CDPSession, x: number, y: number, ms = 700): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await new Promise((r) => setTimeout(r, ms));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function pinch(cdp: CDPSession, cx: number, cy: number, from: number, to: number): Promise<void> {
  const pts = (d: number) => [
    { x: cx - d, y: cy, id: 1 },
    { x: cx + d, y: cy, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / 8) });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** distance on screen between two tiles next to the player (the map's scale) */
async function tileScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const p = app.controller!.session.player().pos;
    const a = app.renderer!.tileToScreen(p);
    const b = app.renderer!.tileToScreen({ x: p.x + 1, y: p.y });
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
}

/** panels and gestures, all by touch: sheets open and fit, then close again */
async function tourPanels(page: Page, cdp: CDPSession, id: string, shoot: boolean): Promise<void> {
  // backpack sheet from the bag button
  await page.locator('.aw-hotbar-tools button').first().tap();
  await expect(page.locator('.aw-backpack')).toBeVisible();
  await page.waitForTimeout(450);
  await checkSheet(page, '.aw-backpack', `${id} backpack`);
  // a tap on a carried item shows its card and actions in the sheet
  const filled = page.locator('.aw-backpack .aw-slot:not(.is-empty)');
  if (await filled.count()) await filled.first().tap();
  await page.waitForTimeout(150);
  if (shoot) await page.screenshot({ path: `${OUT}/mobile-${id}-backpack.png` });
  await page.locator('.aw-backpack .aw-panel-head .aw-icon-btn').tap();
  await expect(page.locator('.aw-backpack')).toBeHidden();

  // rules & threads sheet from the badge
  await page.locator('.aw-rules-badge').tap();
  await expect(page.locator('.aw-rules')).toBeVisible();
  await page.waitForTimeout(450);
  await checkSheet(page, '.aw-rules', `${id} rules`);
  if (shoot) await page.screenshot({ path: `${OUT}/mobile-${id}-rules.png` });
  await page.locator('.aw-rules .aw-panel-head .aw-icon-btn').tap();
  await expect(page.locator('.aw-rules')).toBeHidden();

  // log ticker: tap opens the sheet, a tap elsewhere closes it
  await page.locator('.aw-log').tap();
  await expect(page.locator('.aw-log.is-expanded')).toBeVisible();
  await page.waitForTimeout(450);
  await checkSheet(page, '.aw-log', `${id} log`);
  if (shoot) await page.screenshot({ path: `${OUT}/mobile-${id}-log.png` });
  await page.locator('.aw-hud').tap();
  await expect(page.locator('.aw-log.is-expanded')).toHaveCount(0);
  // the HUD tap opened the full character card (stats); tap again closes it
  await expect(page.locator('.aw-hud.is-expanded .aw-stats')).toBeVisible();
  await page.locator('.aw-hud .aw-hud-name').tap();
  await expect(page.locator('.aw-hud.is-expanded')).toHaveCount(0);

  // goal tracker opens over the map
  await page.locator('.aw-goal-head').tap();
  await expect(page.locator('.aw-goal.is-expanded .aw-goal-body')).toBeVisible();
  await checkSheet(page, '.aw-goal', `${id} goal`);
  await checkSheet(page, '.aw-goal-body', `${id} goal body`);
  if (shoot) await page.screenshot({ path: `${OUT}/mobile-${id}-goal.png` });
  await page.locator('.aw-goal-head').tap();
  await expect(page.locator('.aw-goal.is-expanded')).toHaveCount(0);

  // long-press on the player's tile: the inspect card as a sheet; the next touch closes it
  const me = await page.evaluate(() => window.__anyworld!.controller!.session.player().pos);
  const pt = await tilePoint(page, me);
  if (pt.onMap) {
    await longPress(cdp, pt.x, pt.y);
    await expect(page.locator('.aw-tooltip.is-visible.is-sheet')).toBeVisible();
    await checkSheet(page, '.aw-tooltip.is-visible', `${id} inspect`);
    if (shoot) await page.screenshot({ path: `${OUT}/mobile-${id}-inspect.png` });
    await page.locator('.aw-strip').tap();
    await expect(page.locator('.aw-tooltip.is-visible')).toHaveCount(0);
  }

  // pinch zoom out and back in; the rotate button turns the camera a quarter
  const vp = page.viewportSize()!;
  const before = await tileScale(page);
  const centre = await page.evaluate(() => {
    const ins = window.__anyworld!.controller!.viewportInsets ?? { top: 0, bottom: 0, left: 0, right: 0 };
    return { x: (ins.left + innerWidth - ins.right) / 2, y: (ins.top + innerHeight - ins.bottom) / 2 };
  });
  // fingers apart: closer; fingers together again: back out
  await pinch(cdp, centre.x, centre.y, Math.min(vp.width, vp.height) * 0.12, Math.min(vp.width, vp.height) * 0.32);
  await page.waitForTimeout(400);
  const after = await tileScale(page);
  expect(after, `${id}: spreading two fingers zooms in`).toBeGreaterThan(before * 1.03);
  await pinch(cdp, centre.x, centre.y, Math.min(vp.width, vp.height) * 0.32, Math.min(vp.width, vp.height) * 0.12);
  await page.waitForTimeout(400);
  const back = await tileScale(page);
  expect(back, `${id}: pinching zooms out again`).toBeLessThan(after * 0.97);
  const step0 = await page.evaluate(() => window.__anyworld!.renderer!.cameraStep);
  await page.locator('.aw-map-btn[data-cam="right"]').tap();
  await page.waitForTimeout(500);
  const step1 = await page.evaluate(() => window.__anyworld!.renderer!.cameraStep);
  expect(step1, `${id}: rotate button`).not.toBe(step0);
  await page.locator('.aw-map-btn[data-cam="left"]').tap();
  await page.waitForTimeout(500);
}

const DELTA: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };

for (const c of CASES) {
  test.describe(c.id, () => {
    test.use(phone(c.device));

    test(`${c.id}: touch-only play of ${c.world}`, async ({ page }) => {
      test.setTimeout(TURNS * 1500 + 120000);
      const errors = watchErrors(page);
      await page.addInitScript((lang) => {
        if (!sessionStorage.getItem('mobile-init')) {
          localStorage.clear();
          localStorage.setItem('anyworld.lang.v1', lang);
          sessionStorage.setItem('mobile-init', '1');
        }
      }, c.lang);
      await page.goto(`/?world=${c.world}&seed=${c.seed}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
      await page.waitForTimeout(900);
      const cdp = await page.context().newCDPSession(page);
      await page.screenshot({ path: `${OUT}/mobile-${c.id}-0-intro.png` });
      // the first tap is what unlocks audio on phones: it must be a touch
      await clearIntro(page);
      expect(await layer(page)).toBe('game');
      expect(await page.evaluate(() => document.getElementById('ui-root')!.dataset.input)).toBe('touch');
      await page.waitForTimeout(400);
      await checkLayout(page, `${c.id} start`);
      // the renderer keeps the player in the part of the map the overlay leaves free
      const insets = await page.evaluate(() => window.__anyworld!.controller!.viewportInsets);
      expect(insets, 'viewport insets passed to the renderer').not.toBeNull();
      expect(insets!.top + insets!.bottom + insets!.left + insets!.right).toBeGreaterThan(40);
      await page.screenshot({ path: `${OUT}/mobile-${c.id}-1-start.png` });
      await tourPanels(page, cdp, c.id, true);
      await checkLayout(page, `${c.id} after panels`);

      await page.evaluate(async ([seed, root]) => {
        const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
        (window as unknown as { __mb: unknown }).__mb = { bot: sim.botByName('explorer'), mem: sim.newMemory(seed) };
      }, [c.seed, process.cwd()] as const);

      const startTurn = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
      let shots = 0;
      let areaShot = -1;
      let taps = 0;
      let perkShot = false;
      let rotations = 0;
      let dialogueShot = false;
      for (let i = 0; i < TURNS; i++) {
        const L = await layer(page);
        if (L === 'end') break;
        if (L === 'narration' || L === 'help') {
          await clearIntro(page);
          if (L === 'help') await page.locator('.aw-help').locator('.aw-icon-btn').first().tap().catch(() => undefined);
          continue;
        }
        if (L === 'levelup') {
          await checkSheet(page, '.aw-modal:not([hidden]) .aw-modal-card', `${c.id} perk choice`);
          if (!perkShot) {
            perkShot = true;
            await page.waitForTimeout(250);
            await page.screenshot({ path: `${OUT}/mobile-${c.id}-perk.png` });
          }
          await page.locator('.aw-perk').first().tap();
          await page.waitForTimeout(150);
          continue;
        }
        if (L === 'choice') {
          await checkSheet(page, '.aw-modal:not([hidden]) .aw-modal-card', `${c.id} choice`);
          await page.locator('.aw-modal:not([hidden]) .aw-option').first().tap();
          await page.waitForTimeout(150);
          continue;
        }
        if (L === 'dialogue') {
          await checkSheet(page, '.aw-dialogue', `${c.id} dialogue`);
          if (!dialogueShot) {
            dialogueShot = true;
            await page.waitForTimeout(250);
            await page.screenshot({ path: `${OUT}/mobile-${c.id}-dialogue.png` });
          }
          const opt = page.locator('.aw-dialogue .aw-option:not([disabled])');
          // answer once in a while (quests, trades), otherwise leave
          if (i % 4 === 1 && (await opt.count())) await opt.first().tap();
          else await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost').tap();
          await page.waitForTimeout(150);
          continue;
        }
        if (L === 'trade') {
          await checkSheet(page, '.aw-trade', `${c.id} trade`);
          await page.locator('.aw-trade .aw-dlg-foot .aw-btn-ghost').tap();
          await page.waitForTimeout(150);
          continue;
        }
        if (L === 'target') {
          // the bot's target or the cursor's tile: confirm by tapping it
          const cur = await page.evaluate(() => window.__anyworld!.controller!.session.aim()?.at ?? null);
          const me = await page.evaluate(() => window.__anyworld!.controller!.session.player().pos);
          const pt = await tilePoint(page, cur ?? { x: me.x + 1, y: me.y });
          if (pt.onMap) await page.touchscreen.tap(pt.x, pt.y);
          else await page.locator('.aw-hotbar .aw-slot.is-cursor, .aw-hotbar .aw-slot').first().tap();
          await page.waitForTimeout(120);
          if ((await layer(page)) === 'target') await page.locator('.aw-hotbar-slots .aw-slot').first().tap();
          continue;
        }
        if (L !== 'game' && L !== 'look') {
          // a sheet left open (backpack, rules): close it by touch
          const close = page.locator('.aw-backpack:not([hidden]) .aw-panel-head .aw-icon-btn, .aw-rules:not([hidden]) .aw-panel-head .aw-icon-btn');
          if (await close.count()) await close.first().tap();
          continue;
        }
        const d = await page.evaluate(() => {
          const mb = (window as unknown as { __mb: { bot: { decide: Function }; mem: unknown } }).__mb;
          const s = window.__anyworld!.controller!.session;
          return { a: mb.bot.decide(s.state, s.world, mb.mem), status: s.state.status, area: s.state.area.index, me: s.player().pos, turn: s.state.turn };
        });
        if (d.status !== 'playing') break;
        if (process.env.MOBILE_DEBUG) console.log(`[${c.id}] #${i} turn ${d.turn} layer ${L} ${JSON.stringify(d.a)}`);
        const a = d.a as { type: string; dir?: string; targetId?: string; slot?: number; target?: { x: number; y: number }; pos?: { x: number; y: number } };
        let done = false;
        if (a.type === 'move' && a.dir) {
          const [dx, dy] = DELTA[a.dir];
          const pt = await tilePoint(page, { x: d.me.x + dx, y: d.me.y + dy });
          if (pt.onMap && pt.hits) {
            await page.touchscreen.tap(pt.x, pt.y);
            done = true;
          } else if (pt.onMap && rotations < 2) {
            // the tile hides behind a wall or a model from this side: turn the camera like a player would
            rotations++;
            await page.locator('.aw-map-btn[data-cam="right"]').tap();
            await page.waitForTimeout(450);
            continue;
          }
        } else if (a.type === 'attack' && a.targetId) {
          const pos = await page.evaluate((id) => window.__anyworld!.controller!.session.state.area.actors.find((x) => x.id === id)?.pos ?? null, a.targetId);
          if (pos) {
            const pt = await tilePoint(page, pos, a.targetId);
            if (pt.onMap) {
              await page.touchscreen.tap(pt.x, pt.y);
              done = true;
            }
          }
        } else if (a.type === 'pickup') done = await tapCtx(page, 'pickup');
        else if (a.type === 'transition') done = await tapCtx(page, 'exit');
        else if (a.type === 'talk' || a.type === 'persuade') done = await tapCtx(page, a.type);
        else if (a.type === 'search') done = await tapCtx(page, 'search');
        else if (a.type === 'toggle_sneak') done = await tapCtx(page, 'sneak');
        else if (a.type === 'interact' && a.pos) {
          const pt = await tilePoint(page, a.pos);
          if (pt.onMap) {
            await page.touchscreen.tap(pt.x, pt.y);
            done = true;
          } else done = await tapCtx(page, 'interact');
        } else if (a.type === 'use' && a.slot !== undefined && a.slot < 8) {
          await page.locator('.aw-hotbar-slots .aw-slot').nth(a.slot).tap();
          await page.waitForTimeout(100);
          if ((await layer(page)) === 'target') {
            const pt = a.target ? await tilePoint(page, a.target) : null;
            if (pt?.onMap) await page.touchscreen.tap(pt.x, pt.y);
            else await page.locator('.aw-hotbar-slots .aw-slot').nth(a.slot).tap();
          }
          done = true;
        }
        if (!done) done = await tapCtx(page, 'wait');
        if (!done) {
          // no wait button (a choice is pending elsewhere): tap the player's own tile
          const pt = await tilePoint(page, d.me);
          if (pt.onMap) await page.touchscreen.tap(pt.x, pt.y);
        }
        taps++;
        rotations = 0;
        await page.waitForTimeout(40);
        // let a path-walk / animation finish before deciding again
        await page.waitForFunction(() => !window.__anyworld?.controller?.session['travelDest'], null, { timeout: 8000 }).catch(() => undefined);

        if (i > 0 && i % 60 === 0 && (await layer(page)) === 'game') {
          await checkLayout(page, `${c.id} turn ${d.turn}`);
          if (shots < 3) {
            await page.screenshot({ path: `${OUT}/mobile-${c.id}-2-play-${shots}.png` });
            shots++;
          }
        }
        if (d.area !== areaShot && d.area > 0 && (await layer(page)) === 'game') {
          areaShot = d.area;
          await page.waitForTimeout(500);
          await checkLayout(page, `${c.id} area ${d.area}`);
          await page.screenshot({ path: `${OUT}/mobile-${c.id}-3-area${d.area}.png` });
        }
        if (i === Math.floor(TURNS / 2) && (await layer(page)) === 'game') await tourPanels(page, cdp, `${c.id}-mid`, false);
      }
      const endTurn = await page.evaluate(() => window.__anyworld!.controller?.session.state.turn ?? 0);
      expect(taps, 'the bot played by tapping').toBeGreaterThan(TURNS / 3);
      expect(endTurn - startTurn, 'turns were played').toBeGreaterThan(Math.min(100, TURNS / 3));
      if ((await layer(page)) === 'game') await checkLayout(page, `${c.id} end`);
      await page.screenshot({ path: `${OUT}/mobile-${c.id}-4-end.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}

// tablets keep the corner layout, with touch-sized controls and the camera buttons
for (const t of [
  { id: 'ipad-portrait', device: 'iPad Mini', world: 'fixture-western', seed: 9 },
  { id: 'ipad-landscape', device: 'iPad Mini landscape', world: 'fixture-dream', seed: 4 },
]) {
  test.describe(t.id, () => {
    test.use(phone(t.device));

    test(`${t.id}: tablet layout by touch`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.addInitScript(() => {
        if (!sessionStorage.getItem('mobile-init')) {
          localStorage.clear();
          localStorage.setItem('anyworld.lang.v1', 'en');
          sessionStorage.setItem('mobile-init', '1');
        }
      });
      await page.goto(`/?world=${t.world}&seed=${t.seed}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
      await page.waitForTimeout(900);
      await clearIntro(page);
      expect(await layer(page)).toBe('game');
      await page.waitForTimeout(300);
      await checkLayout(page, `${t.id} start`, /^tablet$/);
      // a few taps on the map walk the player
      const start = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
      await page.evaluate(async (root) => {
        const eng = await import('/@fs' + root + '/src/engine/index.ts');
        (window as unknown as { __legal: unknown }).__legal = eng.legalActions;
      }, process.cwd());
      for (let i = 0; i < 6; i++) {
        // a neighbouring tile the player can walk onto (the engine's legal moves), tapped on screen
        const step = await page.evaluate(() => {
          const s = window.__anyworld!.controller!.session;
          const legal = (window as unknown as { __legal: (st: unknown) => { type: string; dir?: string }[] }).__legal(s.state);
          return { me: s.player().pos, dirs: legal.filter((a) => a.type === 'move').map((a) => a.dir as string) };
        });
        let moved: boolean = false;
        for (const dir of step.dirs) {
          const [dx, dy] = DELTA[dir];
          const pt = await tilePoint(page, { x: step.me.x + dx, y: step.me.y + dy });
          if (!pt.onMap || !pt.hits) continue;
          await page.touchscreen.tap(pt.x, pt.y);
          moved = true;
          break;
        }
        if (!moved) moved = await tapCtx(page, 'wait');
        await page.waitForTimeout(250);
        if ((await layer(page)) !== 'game') await clearIntro(page);
      }
      expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(start);
      await page.locator('.aw-map-btn[data-cam="right"]').tap();
      await page.waitForTimeout(400);
      if ((await layer(page)) === 'game') await checkLayout(page, `${t.id} play`, /^tablet$/);
      await page.screenshot({ path: `${OUT}/mobile-${t.id}.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}
