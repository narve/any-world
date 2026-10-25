/**
 * M5 review round 1 — mobile playtester. iPhone 15 and Pixel 7, portrait and landscape, TOUCH ONLY.
 *
 * Each case plays a demo world deep (the explorer sim bot decides, every decision is carried out by a
 * tap / long-press / context button), and along the way measures what a phone player would feel:
 *  - tap targets (≥ 44 px), overlapping or cut-off overlay elements, horizontal scroll
 *  - thumb reach: where the controls a player needs every turn sit on the screen
 *  - safe areas: a notch / home-bar inset is emulated (CDP Emulation.setSafeAreaInsetsOverride when the
 *    browser has it) and no control may sit inside it
 *  - path-walk: a tap on a far explored tile walks there over several turns
 *  - long-press inspect on an actor / item / the player
 *  - renderer.stats(): draw calls, triangles, fps, tier, pixel ratio
 *  - WebGL context loss (WEBGL_lose_context) mid-run: the game survives, a turn can be played while
 *    lost, and the scene comes back after restore
 * Observations go to tests/review/m5/reports/m5-mobile-pt-<case>.json; screenshots to docs/progress/M5/pt-mobile-r1-*.png.
 * Hard expectations are kept to what the DESIGN requires (§6, §6b).
 *
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.mobile-pt.config.ts
 *      PT_TURNS=<n> changes the number of bot decisions per case (default 320).
 */
import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'docs/progress/M5');
// not test-results/: every Playwright run in the repo wipes that folder
const REPORT = process.env.PT_REPORT ?? resolve(ROOT, 'tests/review/m5/reports');
mkdirSync(OUT, { recursive: true });
mkdirSync(REPORT, { recursive: true });
const TURNS = Number(process.env.PT_TURNS ?? 320);
const ROUND = 'r1';

type Device = (typeof devices)[string];
function phone(name: string): Omit<Device, 'defaultBrowserType'> {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

interface Case {
  id: string;
  device: string;
  world: string;
  seed: number;
  lang: string;
  /** emulated safe-area insets (CSS px) */
  safe: { top: number; bottom: number; left: number; right: number };
}

const CASES: Case[] = [
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'heist-silent-vault', seed: 21, lang: 'en', safe: { top: 59, bottom: 34, left: 0, right: 0 } },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'deep-sea-whale-fall', seed: 8, lang: 'en', safe: { top: 0, bottom: 21, left: 59, right: 59 } },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'detective-sugar-hotel', seed: 13, lang: 'en', safe: { top: 24, bottom: 16, left: 0, right: 0 } },
  { id: 'pixel7-landscape', device: 'Pixel 7 landscape', world: 'nb-troll-direktoratet', seed: 5, lang: 'nb', safe: { top: 0, bottom: 16, left: 24, right: 0 } },
];

const DELTA: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

interface Report {
  id: string;
  world: string;
  device: string;
  safeAreaEmulated: boolean;
  layout: string;
  small: string[];
  overlaps: string[];
  offscreen: string[];
  inSafeArea: string[];
  thumb: Record<string, { cx: number; cy: number; fromBottomPct: number }>;
  stats: Record<string, unknown>[];
  pathWalks: { from: unknown; dest: unknown; dist: number; tiles: number; turns: number; reached: boolean; reason?: string }[];
  inspects: { what: string; ok: boolean; text?: string }[];
  contextLoss: Record<string, unknown>;
  emptyBand: number[];
  turnsPlayed: number;
  areasReached: number;
  status: string;
  errors: string[];
  notes: string[];
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** layout measurements: tap targets, overlap, off-screen, inside the emulated safe area, thumb positions */
async function measure(page: Page, safe: Case['safe']) {
  return page.evaluate((safe) => {
    const vis = (el: Element | null): el is HTMLElement => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || (el as HTMLElement).closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const KEY: Record<string, string> = {
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
    const boxes: { name: string; l: number; t: number; r: number; b: number }[] = [];
    for (const [name, s] of Object.entries(KEY)) {
      const el = document.querySelector(`.aw-game ${s}`);
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      boxes.push({ name, l: r.left, t: r.top, r: r.right, b: r.bottom });
    }
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        if (w > 1 && h > 1) overlaps.push(`${a.name}×${b.name} ${Math.round(w)}x${Math.round(h)}`);
      }
    const W = innerWidth;
    const H = innerHeight;
    const offscreen = boxes.filter((b) => b.l < -1 || b.t < -1 || b.r > W + 1 || b.b > H + 1).map((b) => `${b.name} ${Math.round(b.l)},${Math.round(b.t)}..${Math.round(b.r)},${Math.round(b.b)}`);
    const small: string[] = [];
    const inSafe: string[] = [];
    const sel = '.aw-game :is(.aw-hotbar .aw-slot, .aw-ctx-btn, .aw-hotbar-tools button, .aw-map-btn, .aw-rules-badge, .aw-goal-head, .aw-log, .aw-hud, button)';
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!vis(el)) continue;
      const w = (el as HTMLElement).offsetWidth;
      const h = (el as HTMLElement).offsetHeight;
      const label = `${String(el.className).split(' ')[0]}${(el as HTMLElement).dataset.action ? '[' + (el as HTMLElement).dataset.action + ']' : ''}${(el as HTMLElement).dataset.cam ? '[' + (el as HTMLElement).dataset.cam + ']' : ''}`;
      if (w < 43.5 || h < 43.5) small.push(`${label} ${w}x${h}`);
      const r = el.getBoundingClientRect();
      // inside the ctx scroller only the part in view counts
      if (r.top < safe.top - 0.5 || r.bottom > H - safe.bottom + 0.5 || r.left < safe.left - 0.5 || r.right > W - safe.right + 0.5) {
        if (r.right > 0 && r.left < W) inSafe.push(`${label} ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }
    const thumb: Record<string, { cx: number; cy: number; fromBottomPct: number }> = {};
    const tsel: Record<string, string> = {
      wait: '.aw-ctx-btn[data-action="wait"]',
      slot1: '.aw-hotbar-slots .aw-slot',
      bag: '.aw-hotbar-tools button',
      rotate: '.aw-map-btn[data-cam="right"]',
      goal: '.aw-goal-head',
      log: '.aw-log',
      rulesBadge: '.aw-rules-badge',
      hud: '.aw-hud',
    };
    for (const [k, s] of Object.entries(tsel)) {
      const el = document.querySelector(`.aw-game ${s}`);
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      thumb[k] = { cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2), fromBottomPct: Math.round(((H - (r.top + r.bottom) / 2) / H) * 100) };
    }
    // the band of map between the lowest top panel and the highest bottom panel vs. where the player is drawn
    const scrollW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    return { boxes, overlaps, offscreen, small, inSafe, thumb, W, H, scrollW, layout: document.getElementById('ui-root')?.dataset.layout ?? '' };
  }, safe);
}

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
  try {
    await b.first().tap({ timeout: 8000 });
  } catch (e) {
    if (await b.count()) throw e;
    return false;
  }
  return true;
}

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

async function stats(page: Page, where: string) {
  return page.evaluate((where) => {
    const app = window.__anyworld!;
    const s = app.renderer!.stats();
    const q = app.renderer!.quality;
    return { where, ...s, setting: q.setting, mobile: q.mobile, canvas: `${app.renderer!.gl.domElement.width}x${app.renderer!.gl.domElement.height}` };
  }, where);
}

/** a far, explored, passable, on-screen tile the player can path-walk to (3..8 tiles away) */
async function pathTarget(page: Page) {
  return page.evaluate(async (root) => {
    const travel = await import('/@fs' + root + '/src/client/travel.ts');
    const app = window.__anyworld!;
    const s = app.controller!.session;
    const st = s.state;
    const me = s.player().pos;
    const r = app.renderer!;
    const cands: { p: { x: number; y: number }; d: number; len: number; sx: number; sy: number }[] = [];
    for (let dy = -8; dy <= 8; dy++)
      for (let dx = -8; dx <= 8; dx++) {
        const p = { x: me.x + dx, y: me.y + dy };
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d < 3) continue;
        const path = travel.travelPath(st, p);
        if (!path || path.length < 3) continue;
        if (st.area.actors.some((a: { pos: { x: number; y: number }; hp: number }) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
        const at = r.tileToScreen(p);
        const el = document.elementFromPoint(at.x, at.y);
        if (!el || !el.closest('#game-canvas')) continue;
        const hit = r.pick(at.x, at.y);
        if (!hit || hit.x !== p.x || hit.y !== p.y) continue;
        cands.push({ p, d, len: path.length, sx: at.x, sy: at.y });
      }
    cands.sort((a, b) => b.len - a.len);
    return cands[0] ?? null;
  }, ROOT);
}

for (const c of CASES) {
  test.describe(c.id, () => {
    test.use(phone(c.device));

    test(`${c.id}: deep touch playtest of ${c.world}`, async ({ page }) => {
      test.setTimeout(TURNS * 2000 + 240000);
      const errors = watchErrors(page);
      const rep: Report = {
        id: c.id,
        world: c.world,
        device: c.device,
        safeAreaEmulated: false,
        layout: '',
        small: [],
        overlaps: [],
        offscreen: [],
        inSafeArea: [],
        thumb: {},
        stats: [],
        pathWalks: [],
        inspects: [],
        contextLoss: {},
        emptyBand: [],
        turnsPlayed: 0,
        areasReached: 0,
        status: '',
        errors,
        notes: [],
      };
      const save = () => {
        mkdirSync(REPORT, { recursive: true });
        writeFileSync(`${REPORT}/m5-mobile-pt-${c.id}.json`, JSON.stringify(rep, null, 2));
      };
      const shot = (name: string) => page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-${c.id}-${name}.png` });
      const addUnique = (arr: string[], items: string[], where: string) => {
        for (const it of items) {
          const key = it.replace(/\d+(\.\d+)?/g, '#');
          if (!arr.some((x) => x.replace(/\d+(\.\d+)?/g, '#').includes(key))) arr.push(`${where}: ${it}`);
        }
      };
      const audit = async (where: string) => {
        const m = await measure(page, c.safe);
        rep.layout = m.layout;
        addUnique(rep.small, m.small, where);
        addUnique(rep.overlaps, m.overlaps, where);
        addUnique(rep.offscreen, m.offscreen, where);
        addUnique(rep.inSafeArea, m.inSafe, where);
        if (!Object.keys(rep.thumb).length) rep.thumb = m.thumb;
        expect.soft(m.scrollW, `${where}: no sideways scroll`).toBeLessThanOrEqual(m.W + 1);
        return m;
      };

      await page.addInitScript((lang) => {
        if (!sessionStorage.getItem('pt-init')) {
          localStorage.clear();
          localStorage.setItem('anyworld.lang.v1', lang);
          sessionStorage.setItem('pt-init', '1');
        }
      }, c.lang);
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: c.safe } as never);
        rep.safeAreaEmulated = true;
      } catch (e) {
        rep.notes.push(`safe-area override unavailable: ${String(e).slice(0, 120)}`);
      }
      await page.goto(`/?world=${c.world}&seed=${c.seed}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
      await page.waitForTimeout(900);
      if (rep.safeAreaEmulated) {
        const got = await page.evaluate(() => {
          const d = document.createElement('div');
          d.style.cssText = 'position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)';
          document.body.appendChild(d);
          const cs = getComputedStyle(d);
          const out = [cs.paddingTop, cs.paddingBottom, cs.paddingLeft, cs.paddingRight];
          d.remove();
          return out;
        });
        rep.notes.push(`env(safe-area-inset-*) seen by CSS: ${got.join(' ')}`);
        if (got.every((v) => v === '0px')) rep.safeAreaEmulated = false;
      }
      await shot('0-intro');
      await clearIntro(page);
      expect(await layer(page)).toBe('game');
      expect(await page.evaluate(() => document.getElementById('ui-root')!.dataset.input)).toBe('touch');
      await page.waitForTimeout(500);
      await audit('start');
      rep.stats.push(await stats(page, 'start'));
      await shot('1-start');

      // the player's drawn position in the free part of the screen (empty band check)
      const band = async () =>
        page.evaluate(() => {
          const app = window.__anyworld!;
          const p = app.controller!.session.player();
          const at = app.renderer!.actorScreen(p.id, 0.45) ?? app.renderer!.tileToScreen(p.pos);
          return Math.round((at.y / innerHeight) * 100);
        });
      rep.emptyBand.push(await band());

      // long-press inspect: the player and the nearest visible other actor / item
      const inspect = async (what: string, pos: { x: number; y: number }, id?: string) => {
        const pt = await tilePoint(page, pos, id);
        if (!pt.onMap) {
          rep.inspects.push({ what, ok: false, text: 'not on the free map' });
          return;
        }
        await longPress(cdp, pt.x, pt.y);
        const tip = page.locator('.aw-tooltip.is-visible');
        const ok = await tip.isVisible().catch(() => false);
        const text = ok ? ((await tip.innerText()).replace(/\s+/g, ' ').slice(0, 140)) : undefined;
        if (ok) {
          const r = await tip.boundingBox();
          const vp = page.viewportSize()!;
          if (r && (r.y + r.height > vp.height + 1 || r.x < -1 || r.x + r.width > vp.width + 1)) rep.notes.push(`inspect card for ${what} cut off: ${JSON.stringify(r)}`);
        }
        rep.inspects.push({ what, ok, text });
        if (ok && rep.inspects.filter((x) => x.ok).length <= 2) await shot(`inspect-${what}`);
        // close: tap the strip (outside the map)
        await page.locator('.aw-strip').tap().catch(() => undefined);
        await page.waitForTimeout(200);
        if (await tip.isVisible().catch(() => false)) rep.notes.push(`inspect card for ${what} did not close on the next tap`);
      };
      const me0 = await page.evaluate(() => window.__anyworld!.controller!.session.player());
      await inspect('player', me0.pos, me0.id);

      await page.evaluate(async ([seed, root]) => {
        const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
        (window as unknown as { __mb: unknown }).__mb = { bot: sim.botByName('explorer'), mem: sim.newMemory(seed) };
      }, [c.seed, ROOT] as const);

      const startTurn = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
      let areaShot = 0;
      let playShots = 0;
      let rotations = 0;
      let lostDone = false;
      let inspectedOther = false;
      const shotsTaken = new Set<string>();
      for (let i = 0; i < TURNS; i++) {
        const L = await layer(page);
        if (L === 'end') break;
        if (L === 'narration' || L === 'help') {
          await clearIntro(page);
          if (L === 'help') await page.locator('.aw-help .aw-icon-btn').first().tap().catch(() => undefined);
          continue;
        }
        if (L === 'levelup' || L === 'choice' || L === 'dialogue' || L === 'trade') {
          if (!shotsTaken.has(L)) {
            shotsTaken.add(L);
            await page.waitForTimeout(350);
            await shot(`sheet-${L}`);
            const card = page.locator('.aw-modal:not([hidden]) .aw-modal-card, .aw-dialogue:not([hidden]), .aw-trade:not([hidden])').first();
            const r = await card.boundingBox().catch(() => null);
            const vp = page.viewportSize()!;
            if (r && (r.y < -1 || r.y + r.height > vp.height + 1)) rep.notes.push(`${L} sheet past the viewport: ${JSON.stringify(r)}`);
            if (r && rep.safeAreaEmulated && r.y + r.height > vp.height - c.safe.bottom + 1) {
              // the sheet may extend under the home bar if its own padding keeps buttons clear: check buttons
              const btns = await card.locator('button').evaluateAll((els, sb) => els.filter((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && b.bottom > innerHeight - sb + 0.5; }).map((e) => (e as HTMLElement).innerText.slice(0, 20)), c.safe.bottom);
              if (btns.length) rep.notes.push(`${L} sheet buttons under the home-bar inset: ${btns.join(' | ')}`);
            }
          }
          if (L === 'levelup') await page.locator('.aw-perk').first().tap();
          else if (L === 'choice') await page.locator('.aw-modal:not([hidden]) .aw-option').first().tap();
          else if (L === 'dialogue') {
            const opt = page.locator('.aw-dialogue .aw-option:not([disabled])');
            if (i % 4 === 1 && (await opt.count())) await opt.first().tap();
            else await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost').tap();
          } else await page.locator('.aw-trade .aw-dlg-foot .aw-btn-ghost').tap();
          await page.waitForTimeout(150);
          continue;
        }
        if (L === 'target') {
          const cur = await page.evaluate(() => window.__anyworld!.controller!.session.aim()?.at ?? null);
          const me = await page.evaluate(() => window.__anyworld!.controller!.session.player().pos);
          const pt = await tilePoint(page, cur ?? { x: me.x + 1, y: me.y });
          if (pt.onMap) await page.touchscreen.tap(pt.x, pt.y);
          else await page.locator('.aw-hotbar-slots .aw-slot').first().tap();
          await page.waitForTimeout(120);
          if ((await layer(page)) === 'target') await page.locator('.aw-hotbar-slots .aw-slot').first().tap();
          continue;
        }
        if (L !== 'game' && L !== 'look') {
          const close = page.locator('.aw-backpack:not([hidden]) .aw-panel-head .aw-icon-btn, .aw-rules:not([hidden]) .aw-panel-head .aw-icon-btn');
          if (await close.count()) await close.first().tap();
          else await page.locator('.aw-strip').tap().catch(() => undefined);
          continue;
        }

        // every 40 decisions: a path-walk by tapping a far tile
        if (i % 40 === 20) {
          const tgt = await pathTarget(page);
          if (tgt) {
            const before = await page.evaluate(() => ({ pos: window.__anyworld!.controller!.session.player().pos, turn: window.__anyworld!.controller!.session.state.turn }));
            await page.touchscreen.tap(tgt.sx, tgt.sy);
            await page.waitForTimeout(150);
            await page.waitForFunction(() => !window.__anyworld?.controller?.session.travelDest, null, { timeout: 15000 }).catch(() => undefined);
            await page.waitForTimeout(150);
            const after = await page.evaluate(() => ({ pos: window.__anyworld!.controller!.session.player().pos, turn: window.__anyworld!.controller!.session.state.turn, L: window.__anyworld!.ui.layer() }));
            const reached = after.pos.x === tgt.p.x && after.pos.y === tgt.p.y;
            const tiles = Math.max(Math.abs(after.pos.x - before.pos.x), Math.abs(after.pos.y - before.pos.y));
            rep.pathWalks.push({ from: before.pos, dest: tgt.p, dist: tgt.d, tiles, turns: after.turn - before.turn, reached, reason: reached ? undefined : `layer ${after.L}` });
            continue;
          }
        }

        // once, a long-press on another visible actor or item
        if (!inspectedOther && i > 10) {
          const other = await page.evaluate(() => {
            const s = window.__anyworld!.controller!.session;
            const st = s.state;
            const w = st.area.map.width;
            const seen = st.area.seen as ArrayLike<number>;
            const a = st.area.actors.find((x) => x.id !== st.player.actorId && x.hp > 0 && seen[x.pos.y * w + x.pos.x] === 2);
            if (a) return { what: 'actor', pos: a.pos, id: a.id };
            const it = (st.area.items as { pos: { x: number; y: number } }[]).find((x) => seen[x.pos.y * w + x.pos.x] === 2);
            return it ? { what: 'item', pos: it.pos, id: undefined } : null;
          });
          if (other) {
            inspectedOther = true;
            await inspect(other.what, other.pos, other.id);
            continue;
          }
        }

        // context loss mid-run, once
        if (!lostDone && i >= Math.floor(TURNS / 3)) {
          lostDone = true;
          const cl: Record<string, unknown> = {};
          cl.before = await stats(page, 'before-loss');
          const hasExt = await page.evaluate(() => {
            const gl = window.__anyworld!.renderer!.gl.getContext();
            const ext = gl.getExtension('WEBGL_lose_context');
            (window as unknown as { __lose: unknown }).__lose = ext;
            if (!ext) return false;
            ext.loseContext();
            return true;
          });
          cl.extension = hasExt;
          if (hasExt) {
            await page.waitForTimeout(600);
            cl.lostStats = await stats(page, 'lost');
            cl.noticeShown = await page.evaluate(() => {
              const t = document.body.innerText;
              return /context|graphics|grafikk|reload|last inn/i.test(t) ? t.match(/.{0,40}(context|graphics|grafikk|reload|last inn).{0,40}/i)?.[0] ?? true : false;
            });
            await shot('ctx-lost');
            // play a turn while lost: the wait button
            const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
            const waited = await tapCtx(page, 'wait');
            await page.waitForTimeout(300);
            cl.turnWhileLost = waited ? (await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)) - t0 : 'no wait button';
            await page.evaluate(() => (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext());
            await page.waitForTimeout(1500);
            cl.after = await stats(page, 'restored');
            // the player is drawn on its tile again
            cl.playerOnTile = await page.evaluate(() => {
              const app = window.__anyworld!;
              const p = app.controller!.session.player();
              const at = app.renderer!.tileToScreen(p.pos);
              const hit = app.renderer!.pick(at.x, at.y);
              return !!hit && hit.x === p.pos.x && hit.y === p.pos.y;
            });
            // and the canvas really shows something (not all one colour)
            const png = await page.locator('#game-canvas canvas').screenshot();
            cl.canvasBytes = png.length;
            await shot('ctx-restored');
            expect.soft((cl.after as { drawCalls: number }).drawCalls, 'draw calls after restore').toBeGreaterThan(0);
            expect.soft((cl.after as { contextLost: boolean }).contextLost, 'context restored').toBe(false);
          }
          rep.contextLoss = cl;
          save();
          continue;
        }

        const d = await page.evaluate(() => {
          const mb = (window as unknown as { __mb: { bot: { decide: Function }; mem: unknown } }).__mb;
          const s = window.__anyworld!.controller!.session;
          return { a: mb.bot.decide(s.state, s.world, mb.mem), status: s.state.status, area: s.state.area.index, me: s.player().pos, turn: s.state.turn };
        });
        if (d.status !== 'playing') break;
        const a = d.a as { type: string; dir?: string; targetId?: string; slot?: number; target?: { x: number; y: number }; pos?: { x: number; y: number } };
        let done = false;
        if (a.type === 'move' && a.dir) {
          const [dx, dy] = DELTA[a.dir];
          const pt = await tilePoint(page, { x: d.me.x + dx, y: d.me.y + dy });
          if (pt.onMap && pt.hits) {
            await page.touchscreen.tap(pt.x, pt.y);
            done = true;
          } else if (pt.onMap && rotations < 2) {
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
          const pt = await tilePoint(page, d.me);
          if (pt.onMap) await page.touchscreen.tap(pt.x, pt.y);
        }
        rotations = 0;
        await page.waitForTimeout(40);
        await page.waitForFunction(() => !window.__anyworld?.controller?.session.travelDest, null, { timeout: 8000 }).catch(() => undefined);
        // a "no known way there" toast after a tap the engine could carry out is worth knowing about
        const noWay = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('.aw-toast')) as HTMLElement[];
          const hit = els.filter((e) => /No known way|Ingen kjent vei/.test(e.innerText) && !e.dataset.ptSeen);
          for (const e of hit) e.dataset.ptSeen = '1';
          return hit.length > 0;
        });
        if (noWay) {
          const now = await page.evaluate(
            async ([dir, root]) => {
              const eng = await import('/@fs' + root + '/src/engine/index.ts');
              const travel = await import('/@fs' + root + '/src/client/travel.ts');
              const s = window.__anyworld!.controller!.session;
              const me = s.player().pos;
              const D: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
              const dd = dir ? D[dir as string] : [0, 0];
              const t = { x: me.x + dd[0], y: me.y + dd[1] };
              const w = s.state.area.map.width;
              return {
                me,
                turn: s.state.turn,
                L: window.__anyworld!.ui.layer(),
                legalMove: (eng.legalActions(s.state) as { type: string; dir?: string }[]).some((x) => x.type === 'move' && x.dir === dir),
                seen: (s.state.area.seen as ArrayLike<number>)[t.y * w + t.x],
                path: travel.travelPath(s.state, t),
                actorThere: s.state.area.actors.some((x: { hp: number; pos: { x: number; y: number } }) => x.hp > 0 && x.pos.x === t.x && x.pos.y === t.y),
              };
            },
            [a.dir ?? null, ROOT] as const,
          );
          rep.notes.push(`noWay toast after bot action ${JSON.stringify(a)} from ${JSON.stringify(d.me)} turn ${d.turn} -> ${JSON.stringify(now)}`);
        }

        if (d.area !== areaShot && d.area > 0 && (await layer(page)) === 'game') {
          areaShot = d.area;
          rep.areasReached = Math.max(rep.areasReached, d.area);
          await page.waitForTimeout(600);
          await audit(`area ${d.area}`);
          rep.stats.push(await stats(page, `area ${d.area}`));
          rep.emptyBand.push(await band());
          await shot(`3-area${d.area}`);
        }
        if (i > 0 && i % 80 === 0 && (await layer(page)) === 'game') {
          await audit(`turn ${d.turn}`);
          rep.stats.push(await stats(page, `turn ${d.turn}`));
          rep.emptyBand.push(await band());
          if (playShots < 2) await shot(`2-play-${playShots++}`);
          save();
        }
      }
      const fin = await page.evaluate(() => ({ turn: window.__anyworld!.controller?.session.state.turn ?? 0, status: window.__anyworld!.controller?.session.state.status ?? '?', area: window.__anyworld!.controller?.session.state.area.index ?? 0 }));
      rep.turnsPlayed = fin.turn - startTurn;
      rep.status = fin.status;
      rep.areasReached = Math.max(rep.areasReached, fin.area);
      if ((await layer(page)) === 'game') await audit('end');
      await page.waitForTimeout(400);
      await shot('4-end');
      // end screen layout
      if ((await layer(page)) === 'end') {
        const btns = await page.locator('.aw-end button, .aw-modal:not([hidden]) button').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).map((e) => ({ t: (e as HTMLElement).innerText.slice(0, 20), h: (e as HTMLElement).offsetHeight, w: (e as HTMLElement).offsetWidth, b: e.getBoundingClientRect().bottom })));
        rep.notes.push(`end buttons: ${JSON.stringify(btns)}`);
      }
      save();
      expect(rep.turnsPlayed, 'turns were played by touch').toBeGreaterThan(Math.min(80, TURNS / 3));
      expect.soft(rep.small, 'tap targets ≥ 44 px').toEqual([]);
      expect.soft(rep.overlaps, 'overlay elements overlap').toEqual([]);
      expect.soft(rep.offscreen, 'overlay elements cut off').toEqual([]);
      expect.soft(errors, errors.join('\n')).toEqual([]);
    });
  });
}

// Focused probes (iPhone 15 portrait): a long-press is inspect only, and a lost WebGL context is told
// to the player.
test.describe('probes', () => {
  test.use(phone('iPhone 15'));

  test('long-press inspects without acting', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pt-init')) {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'en');
        sessionStorage.setItem('pt-init', '1');
      }
    });
    await page.goto('/?world=heist-silent-vault&seed=21');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await clearIntro(page);
    const cdp = await page.context().newCDPSession(page);
    const snap = () =>
      page.evaluate(() => {
        const s = window.__anyworld!.controller!.session;
        return { turn: s.state.turn, pos: s.player().pos, layer: window.__anyworld!.ui.layer(), toasts: Array.from(document.querySelectorAll('.aw-toast')).map((e) => (e as HTMLElement).innerText) };
      });
    // every visible tile around the player within 4, plus every visible actor
    const targets = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      const st = s.state;
      const me = s.player().pos;
      const out: { x: number; y: number; id?: string }[] = [];
      for (const a of st.area.actors) if (a.id !== st.player.actorId && a.hp > 0) out.push({ ...a.pos, id: a.id });
      for (const [dx, dy] of [[0, 3], [2, -2], [-3, 0], [0, -4]]) out.push({ x: me.x + dx, y: me.y + dy });
      return out;
    });
    const problems: string[] = [];
    for (const tg of targets) {
      const pt = await tilePoint(page, tg, tg.id);
      if (!pt.onMap) continue;
      const before = await snap();
      await longPress(cdp, pt.x, pt.y, 800);
      await page.waitForTimeout(300);
      const after = await snap();
      const tip = await page.locator('.aw-tooltip.is-visible').isVisible();
      if (after.turn !== before.turn || after.pos.x !== before.pos.x || after.pos.y !== before.pos.y) problems.push(`long-press on ${JSON.stringify(tg)} acted: turn ${before.turn}->${after.turn}`);
      const newToasts = after.toasts.filter((x) => !before.toasts.includes(x));
      if (newToasts.length) problems.push(`long-press on ${JSON.stringify(tg)} raised toast(s): ${newToasts.join(' | ')}`);
      // nothing to describe on a never-seen tile or an actor out of sight: no card is right there
      const known = await page.evaluate((p) => {
        const st = window.__anyworld!.controller!.session.state;
        return ((st.area.seen as ArrayLike<number>)[p.y * st.area.map.width + p.x] ?? 0) === 2;
      }, tg);
      if (!tip && known) problems.push(`long-press on ${JSON.stringify(tg)} showed no inspect card`);
      await page.locator('.aw-strip').tap();
      await page.waitForTimeout(250);
    }
    mkdirSync(REPORT, { recursive: true });
    writeFileSync(`${REPORT}/m5-mobile-pt-probe-longpress.json`, JSON.stringify({ targets, problems }, null, 2));
    expect.soft(problems).toEqual([]);
  });
});

// Path-walk probe: fast-forward a run with the bot through the controller (not touch: this only sets
// the scene), then tap far explored tiles and record why a walk did or did not happen.
test.describe('probes-pathwalk', () => {
  test.use(phone('iPhone 15'));

  test('path-walk after some play', async ({ page }) => {
    test.setTimeout(400000);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pt-init')) {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'en');
        sessionStorage.setItem('pt-init', '1');
      }
    });
    await page.goto('/?world=heist-silent-vault&seed=21');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await clearIntro(page);
    await page.evaluate(async (root) => {
      const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
      (window as unknown as { __mb: unknown }).__mb = { bot: sim.botByName('explorer'), mem: sim.newMemory(21) };
    }, ROOT);
    const results: unknown[] = [];
    for (let round = 0; round < 8; round++) {
      // 25 bot actions through the controller
      for (let k = 0; k < 25; k++) {
        const L = await layer(page);
        if (L === 'end') break;
        if (L !== 'game') {
          await clearIntro(page);
          await page.locator('.aw-modal:not([hidden]) .aw-option, .aw-perk').first().tap().catch(() => undefined);
          await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost, .aw-trade .aw-dlg-foot .aw-btn-ghost').first().tap().catch(() => undefined);
          continue;
        }
        await page.evaluate(() => {
          const mb = (window as unknown as { __mb: { bot: { decide: Function }; mem: unknown } }).__mb;
          const c = window.__anyworld!.controller!;
          c.onAction(mb.bot.decide(c.session.state, c.session.world, mb.mem));
        });
        await page.waitForTimeout(60);
      }
      if ((await layer(page)) !== 'game') continue;
      await page.waitForTimeout(400);
      const tgt = await pathTarget(page);
      if (!tgt) continue;
      const diag = await page.evaluate(() => {
        const app = window.__anyworld!;
        const s = app.controller!.session;
        return { turn: s.state.turn, me: s.player().pos, mode: s.mode, layer: app.ui.layer(), blocking: app.ui.isBlocking(), goalExpanded: (app.ui as unknown as { goalExpanded(): boolean }).goalExpanded(), tooltip: !!document.querySelector('.aw-tooltip.is-visible') };
      });
      const toastsBefore = await page.locator('.aw-toast').allInnerTexts();
      await page.evaluate(() => {
        const w = window as unknown as { __ev: unknown[]; __hooked?: boolean };
        w.__ev = [];
        if (w.__hooked) return;
        w.__hooked = true;
        for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend']) {
          addEventListener(t, (e) => {
            const el = e.target as HTMLElement;
            w.__ev.push([t, (e as PointerEvent).pointerType ?? '', el.id || String(el.className).slice(0, 30), Math.round((e as PointerEvent).clientX ?? 0), Math.round((e as PointerEvent).clientY ?? 0)]);
          }, true);
        }
        const c = window.__anyworld!.controller! as unknown as { onTap(p: unknown): void };
        const orig = c.onTap.bind(c);
        c.onTap = (p: unknown) => {
          w.__ev.push(['onTap', JSON.stringify(p)]);
          orig(p);
        };
      });
      await page.touchscreen.tap(tgt.sx, tgt.sy);
      await page.waitForTimeout(100);
      const mid = await page.evaluate(() => ({ dest: window.__anyworld!.controller!.session.travelDest, turn: window.__anyworld!.controller!.session.state.turn }));
      await page.waitForFunction(() => !window.__anyworld?.controller?.session.travelDest, null, { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ turn: window.__anyworld!.controller!.session.state.turn, me: window.__anyworld!.controller!.session.player().pos, layer: window.__anyworld!.ui.layer() }));
      const toasts = (await page.locator('.aw-toast').allInnerTexts()).filter((x) => !toastsBefore.includes(x));
      const ev = await page.evaluate(() => (window as unknown as { __ev: unknown[] }).__ev);
      const pickNow = await page.evaluate(([x, y]) => window.__anyworld!.renderer!.pick(x, y), [tgt.sx, tgt.sy] as const);
      results.push({ round, tgt: tgt.p, at: [Math.round(tgt.sx), Math.round(tgt.sy)], pickNow, len: tgt.len, diag, mid, after, toasts, ev });
      if (after.turn === diag.turn) await page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-probe-pathwalk-fail-${round}.png` });
    }
    mkdirSync(REPORT, { recursive: true });
    writeFileSync(`${REPORT}/m5-mobile-pt-probe-pathwalk.json`, JSON.stringify(results, null, 2));
  });
});

// Inspect-card dismissal probe (iPhone 15 landscape): after a long-press, does a tap on the card, on a
// context button or on the HUD close the card?
test.describe('probes-inspect-dismiss', () => {
  test.use(phone('iPhone 15 landscape'));

  test('inspect card closes on the next touch', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pt-init')) {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'en');
        sessionStorage.setItem('pt-init', '1');
      }
    });
    await page.goto('/?world=deep-sea-whale-fall&seed=8');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await clearIntro(page);
    const cdp = await page.context().newCDPSession(page);
    const tip = page.locator('.aw-tooltip.is-visible');
    const out: Record<string, unknown> = {};
    const open = async () => {
      const me = await page.evaluate(() => window.__anyworld!.controller!.session.player());
      const pt = await tilePoint(page, me.pos, me.id);
      await longPress(cdp, pt.x, pt.y);
      await page.waitForTimeout(300);
      return tip.isVisible();
    };
    for (const [name, sel] of [
      ['strip', '.aw-strip'],
      ['card itself', '.aw-tooltip.is-visible'],
      ['hud', '.aw-hud-name'],
      ['ctx wait', '.aw-ctx-btn[data-action="wait"]'],
      ['ctx talk', '.aw-ctx-btn[data-action="talk"]'],
    ] as const) {
      if (!(await open())) {
        out[name] = 'card did not open';
        continue;
      }
      const box = await tip.boundingBox();
      const target = page.locator(sel).first();
      if (!(await target.isVisible().catch(() => false))) {
        out[name] = 'target not visible';
        continue;
      }
      const tb = await target.boundingBox();
      const covered = await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? '', [tb!.x + tb!.width / 2, tb!.y + tb!.height / 2] as const);
      await page.touchscreen.tap(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2);
      await page.waitForTimeout(400);
      out[name] = { stillOpen: await tip.isVisible(), layer: await layer(page), cardBox: box, hitElement: String(covered).slice(0, 60) };
      if (name === 'ctx talk') await page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-probe-inspect-then-talk.png` });
      // reset: close anything open
      for (let k = 0; k < 3 && (await layer(page)) !== 'game'; k++) await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost').tap().catch(() => undefined);
      const me = await page.evaluate(() => window.__anyworld!.controller!.session.player());
      const pt = await tilePoint(page, me.pos, me.id);
      await page.touchscreen.tap(pt.x - 60, pt.y + 40).catch(() => undefined);
      await page.waitForTimeout(400);
    }
    mkdirSync(REPORT, { recursive: true });
    writeFileSync(`${REPORT}/m5-mobile-pt-probe-inspect-dismiss.json`, JSON.stringify(out, null, 2));
  });
});
