/**
 * M5 review round 3 — mobile playtester. iPhone 15 and Pixel 7, portrait and landscape, TOUCH ONLY.
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
 * Observations go to tests/review/m5/reports/m5-mobile-pt-<case>.json; screenshots to docs/progress/M5/pt-mobile-r3-*.png.
 * Hard expectations are kept to what the DESIGN requires (§6, §6b).
 *
 * Round 2 adds (verifying the round-1 fixes and the related client fixes): actors drawn under a panel
 * (hostiles hidden by the HUD / hotbar / context buttons), Wait fully on screen and context labels not
 * clipped, the goal step not clipped, item thumbnails in the slots, toasts over sheets, every sheet
 * button inside the viewport and above the home bar, trade names ellipsised, the lost-graphics notice,
 * and after the end screen: "New world" lands at the top of the start screen and the next run shows
 * its prologue and how-to-play card before the first move. Different worlds than round 1.
 *
 * Round 3 (this file, copied from round 2): different worlds again; the hidden-hostile audit now waits
 * for the renderer's auto framing (it samples panels every 500 ms once the camera rests); the occlusion
 * probes assert that a tap on a hostile behind the player attacks it; a touch ranged-fire probe.
 *
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.mobile-pt-r3.config.ts
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
const TURNS = Number(process.env.PT_TURNS ?? 900);
const ROUND = 'r3';

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
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'detective-sugar-hotel', seed: 5, lang: 'en', safe: { top: 59, bottom: 34, left: 0, right: 0 } },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'deep-sea-whale-fall', seed: 9, lang: 'en', safe: { top: 0, bottom: 21, left: 59, right: 59 } },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'nb-troll-direktoratet', seed: 6, lang: 'nb', safe: { top: 24, bottom: 16, left: 0, right: 0 } },
  { id: 'pixel7-landscape', device: 'Pixel 7 landscape', world: 'alien-twilight-migration', seed: 12, lang: 'en', safe: { top: 0, bottom: 16, left: 24, right: 0 } },
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
  /** actors drawn where a panel covers them */
  hiddenActors: string[];
  /** text clipped without an ellipsis, Wait not fully on screen */
  clipped: string[];
  /** sheets: toasts over them, buttons outside the viewport / under the home bar */
  sheets: string[];
  thumbs: Record<string, unknown>;
  secondRun: Record<string, unknown>;
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

/** round 2: actors under panels, clipped labels, Wait on screen, slot thumbnails */
async function extraAudit(page: Page) {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const s = app.controller!.session;
    const st = s.state;
    const r = app.renderer!;
    const w = st.area.map.width;
    const seen = st.players[st.party[0]].seen as ArrayLike<number>;
    const hidden: string[] = [];
    for (const a of st.area.actors as { id: string; hp: number; pos: { x: number; y: number }; faction: string; defId: string }[]) {
      if (a.hp <= 0 || a.id === st.players[st.party[0]].actorId || seen[a.pos.y * w + a.pos.x] !== 2) continue;
      const pts = [r.actorScreen(a.id, 0.45), r.tileToScreen(a.pos)].filter(Boolean) as { x: number; y: number }[];
      // on screen at all? (off-screen actors are the camera's business, not a panel's)
      const on = pts.filter((p) => p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight);
      if (!on.length) continue;
      const covers = on.map((p) => document.elementFromPoint(p.x, p.y) as HTMLElement | null).filter((el) => !!el && !el.closest('#game-canvas'));
      if (covers.length === on.length) {
        const el = covers[0]!;
        const panel = el.closest('.aw-hud, .aw-strip, .aw-goal, .aw-log, .aw-ctx, .aw-hotbar, .aw-map-tools, .aw-rules-badge, .aw-toast, .aw-mode-banner') as HTMLElement | null;
        hidden.push(`${a.faction}:${a.defId} under ${panel ? String(panel.className).split(' ')[0] : String(el.className).slice(0, 30)}`);
      }
    }
    const clipped: string[] = [];
    const clip = (el: HTMLElement, what: string) => {
      if (el.scrollWidth > el.clientWidth + 1) {
        const cs = getComputedStyle(el);
        if (cs.textOverflow !== 'ellipsis' || cs.whiteSpace !== 'nowrap') clipped.push(`${what} "${el.innerText.slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth} (${cs.textOverflow}/${cs.whiteSpace})`);
      }
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.aw-game .aw-ctx:not([hidden]) .aw-ctx-btn, .aw-game .aw-ctx:not([hidden]) .aw-ctx-btn *'))) if (el.offsetWidth) clip(el, `ctx[${el.closest<HTMLElement>('.aw-ctx-btn')!.dataset.action}]`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.aw-game .aw-goal-step-text, .aw-game .aw-goal-summary, .aw-game .aw-strip *, .aw-game .aw-hud-name'))) if (el.offsetWidth && !el.closest('[hidden]')) clip(el, String(el.className).split(' ')[0]);
    const wait = document.querySelector<HTMLElement>('.aw-game .aw-ctx:not([hidden]) .aw-ctx-btn[data-action="wait"]');
    let waitOk: boolean | null = null;
    if (wait) {
      const b = wait.getBoundingClientRect();
      const sc = wait.closest('.aw-ctx')!.getBoundingClientRect();
      waitOk = b.left >= Math.max(0, sc.left) - 1 && b.right <= Math.min(innerWidth, sc.right) + 1 && b.top >= Math.max(0, sc.top) - 1 && b.bottom <= Math.min(innerHeight, sc.bottom) + 1;
      if (!waitOk) clipped.push(`wait not fully visible ${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)} in ctx ${Math.round(sc.left)}..${Math.round(sc.right)}`);
    }
    const slots = Array.from(document.querySelectorAll<HTMLElement>('.aw-game .aw-hotbar-slots .aw-slot'));
    const filled = slots.filter((x) => x.querySelector('.aw-glyph'));
    const thumbs = { slots: slots.length, filled: filled.length, withImg: filled.filter((x) => x.querySelector('.aw-glyph img')).length };
    return { hidden, clipped, thumbs, waitOk };
  });
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

/** context buttons a panel covered when the bot wanted them */
const COVERED: Record<string, unknown>[] = [];

async function tapCtx(page: Page, action: string): Promise<boolean> {
  const b = page.locator(`.aw-ctx:not([hidden]) .aw-ctx-btn[data-action="${action}"]`);
  if (!(await b.count()) || !(await b.first().isVisible())) return false;
  await b.first().scrollIntoViewIfNeeded().catch(() => undefined);
  // a panel over the button: a player's finger would hit the panel, so does ours (and it is recorded)
  const cover = await b.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2) as HTMLElement | null;
    if (!top || el.contains(top)) return null;
    const panel = top.closest('[class*="aw-"]') as HTMLElement | null;
    const log = document.querySelector<HTMLElement>('.aw-game .aw-log');
    const lr = log?.getBoundingClientRect();
    return { by: String(panel?.className ?? top.className).slice(0, 60), btn: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], logBox: lr ? [Math.round(lr.left), Math.round(lr.top), Math.round(lr.right), Math.round(lr.bottom)] : null, logExpanded: !!log?.classList.contains('is-expanded'), turn: window.__anyworld?.controller?.session.state.turn };
  });
  if (cover) {
    COVERED.push({ action, ...cover });
    if (COVERED.length === 1) await page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-covered-${(page.viewportSize()!.width)}x${page.viewportSize()!.height}.png` });
    return false;
  }
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

/** every scrolled element on the start screen (the screen and its columns) */
async function startScroll(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const scr = document.querySelector<HTMLElement>('.aw-start');
    if (!scr) return ['no start screen'];
    for (const el of [scr, ...Array.from(scr.querySelectorAll<HTMLElement>('*'))]) if (el.scrollTop > 0) out.push(`${String(el.className).split(' ')[0]} ${Math.round(el.scrollTop)}`);
    if (document.scrollingElement && document.scrollingElement.scrollTop > 0) out.push(`document ${Math.round(document.scrollingElement.scrollTop)}`);
    return out;
  });
}

/** swipe the start screen with a touch scroll gesture until the demo card of `world` is in view, then tap it */
async function tapDemo(page: Page, cdp: CDPSession, world: string): Promise<boolean> {
  const card = page.locator(`.aw-start .aw-demo[data-world="${world}"]`).first();
  if (!(await card.count())) return false;
  for (let k = 0; k < 30; k++) {
    const b = await card.boundingBox();
    const vp = page.viewportSize()!;
    if (b && b.y > 40 && b.y + b.height < vp.height - 40) break;
    const up = !b || b.y > vp.height / 2;
    await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2), yDistance: up ? -Math.round(vp.height * 0.35) : Math.round(vp.height * 0.35), gestureSourceType: 'touch', speed: 1600 } as never);
    await page.waitForTimeout(250);
  }
  await card.tap();
  return true;
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
        hiddenActors: [],
        clipped: [],
        sheets: [],
        thumbs: {},
        secondRun: {},
        turnsPlayed: 0,
        areasReached: 0,
        status: '',
        errors,
        notes: [],
      };
      const save = () => {
        mkdirSync(REPORT, { recursive: true });
        writeFileSync(`${REPORT}/m5-mobile-pt-${ROUND}-${c.id}.json`, JSON.stringify(rep, null, 2));
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
        const x = await extraAudit(page);
        addUnique(rep.hiddenActors, x.hidden, where);
        addUnique(rep.clipped, x.clipped, where);
        rep.thumbs[where] = x.thumbs;
        expect.soft(m.scrollW, `${where}: no sideways scroll`).toBeLessThanOrEqual(m.W + 1);
        return m;
      };

      await page.addInitScript((lang) => {
        // which touch opened the goal sheet (round 2: it opened by itself during map play)
        (window as unknown as { __goalTaps: unknown[] }).__goalTaps = [];
        addEventListener(
          'pointerdown',
          (e) => {
            const el = e.target as HTMLElement | null;
            if (el && el.closest && el.closest('.aw-goal-head')) {
              const r = el.closest('.aw-goal')!.getBoundingClientRect();
              (window as unknown as { __goalTaps: unknown[] }).__goalTaps.push({ x: Math.round(e.clientX), y: Math.round(e.clientY), goal: [Math.round(r.top), Math.round(r.bottom)], turn: (window as unknown as { __anyworld?: { controller?: { session: { state: { turn: number } } } } }).__anyworld?.controller?.session.state.turn });
            }
          },
          true,
        );
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
      // the run starts like a player's would: the start screen, a swipe down to the demo, a tap
      await page.goto('/');
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
      await page.waitForTimeout(600);
      const tapped = await tapDemo(page, cdp, c.world);
      if (!tapped) {
        rep.notes.push(`no demo card for ${c.world} on the start screen: started by URL`);
        await page.goto(`/?world=${c.world}&seed=${c.seed}`);
        await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
      } else rep.notes.push(`start screen scrolled before the first run: ${JSON.stringify(await startScroll(page))}`);
      await page.waitForFunction(() => ['narration', 'game', 'help'].includes(window.__anyworld?.ui.layer() ?? ''), null, { timeout: 60000 });
      await page.waitForTimeout(900);
      rep.notes.push(`first run opened on layer ${await layer(page)}`);
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
      let lastTap: unknown = null;
      let stallTurn = -1;
      let targetMiss = 0;
      let aimNotes = 0;
      let stall = 0;
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
          {
            // every time a sheet is up: toasts over it, buttons outside the screen / under the home bar, clipped trade names
            // (after the sheet's slide-in: measured mid-animation the buttons are still below their place)
            await page.waitForTimeout(800);
            const sh = await page.evaluate(([sb, sl, sr]) => {
              const card = document.querySelector<HTMLElement>('.aw-modal:not([hidden]) .aw-modal-card, .aw-dialogue:not([hidden]), .aw-trade:not([hidden])');
              if (!card) return { out: [] as string[], toastHit: false };
              const cr = card.getBoundingClientRect();
              const out: string[] = [];
              let toastHit = false;
              for (const t of Array.from(document.querySelectorAll<HTMLElement>('.aw-toast'))) {
                const tr = t.getBoundingClientRect();
                if (!tr.width || getComputedStyle(t).opacity === '0') continue;
                const ow = Math.min(tr.right, cr.right) - Math.max(tr.left, cr.left);
                const oh = Math.min(tr.bottom, cr.bottom) - Math.max(tr.top, cr.top);
                const top = document.elementFromPoint((tr.left + tr.right) / 2, (tr.top + tr.bottom) / 2);
                if (ow > 2 && oh > 2 && top && t.contains(top)) {
                  out.push(`toast over sheet: "${t.innerText.slice(0, 40)}"`);
                  toastHit = true;
                }
              }
              for (const b of Array.from(card.querySelectorAll<HTMLElement>('button'))) {
                const r = b.getBoundingClientRect();
                if (!r.height || b.closest('[hidden]')) continue;
                // inside a scrolling list only the part that can be scrolled to counts
                let sc: HTMLElement | null = b.parentElement;
                while (sc && sc !== card && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
                const scrolls = !!sc && sc !== card && sc.scrollHeight > sc.clientHeight + 1;
                const cardScrolls = card.scrollHeight > card.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(card).overflowY);
                if (scrolls || cardScrolls) continue;
                const lbl = b.innerText.replace(/\s+/g, ' ').slice(0, 24) || b.getAttribute('aria-label') || '?';
                if (r.bottom > innerHeight + 1 || r.top < -1) out.push(`button off screen: "${lbl}" ${Math.round(r.top)}..${Math.round(r.bottom)} / ${innerHeight}`);
                else if (r.bottom > innerHeight - sb + 0.5) out.push(`button under home bar: "${lbl}" bottom ${Math.round(r.bottom)} > ${innerHeight - sb}`);
                if (r.left < sl - 0.5 || r.right > innerWidth - sr + 0.5) out.push(`button in side inset: "${lbl}" ${Math.round(r.left)}..${Math.round(r.right)}`);
              }
              for (const n of Array.from(card.querySelectorAll<HTMLElement>('.aw-trade-label, .aw-option, .aw-card-title'))) {
                if (n.scrollWidth > n.clientWidth + 1) {
                  const cs = getComputedStyle(n);
                  if (cs.textOverflow !== 'ellipsis') out.push(`clipped ${n.className.split(' ')[0]} "${n.innerText.slice(0, 30)}" ${n.scrollWidth}>${n.clientWidth}`);
                }
              }
              return { out, toastHit };
            }, [rep.safeAreaEmulated ? c.safe.bottom : 0, rep.safeAreaEmulated ? c.safe.left : 0, rep.safeAreaEmulated ? c.safe.right : 0] as const);
            addUnique(rep.sheets, sh.out, L);
            if (sh.toastHit && !shotsTaken.has(`toast-${L}`)) {
              shotsTaken.add(`toast-${L}`);
              await shot(`sheet-${L}-toast`);
            }
            if (sh.out.some((x) => x.startsWith('button')) && !shotsTaken.has(`btn-${L}`)) {
              shotsTaken.add(`btn-${L}`);
              await shot(`sheet-${L}-buttons`);
            }
            if (L === 'trade' && !rep.thumbs.trade) rep.thumbs.trade = await page.evaluate(() => ({ rows: document.querySelectorAll('.aw-trade .aw-trade-row').length, withImg: document.querySelectorAll('.aw-trade .aw-trade-row .aw-glyph img').length }));
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
          // still aiming: the banner's Cancel (touch has no Esc)
          if ((await layer(page)) === 'target') {
            targetMiss++;
            await page.locator('.aw-mode-banner button').last().tap().catch(() => undefined);
          }
          continue;
        }
        // the goal sheet open over the map: who opened it? (the bot never taps it on purpose)
        if (L === 'game' && (await page.locator('.aw-game .aw-log.is-expanded').count())) {
          rep.notes.push(`log sheet found open at turn ${await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)}; last test tap ${JSON.stringify(lastTap)}`);
          if (!shotsTaken.has('log-open')) {
            shotsTaken.add('log-open');
            await shot('log-open');
          }
          await page.locator('.aw-game .aw-log').tap();
          await page.waitForTimeout(200);
          continue;
        }
        if (L === 'game' && (await page.locator('.aw-goal-head[aria-expanded="true"]').count())) {
          const taps = await page.evaluate(() => (window as unknown as { __goalTaps: unknown[] }).__goalTaps.splice(0));
          rep.notes.push(`goal sheet found open at turn ${await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)}; last test tap ${JSON.stringify(lastTap)}; goal pointerdowns ${JSON.stringify(taps)}`);
          if (!shotsTaken.has('goal-open')) {
            shotsTaken.add('goal-open');
            await shot('goal-open');
          }
          await page.locator('.aw-goal-head').tap();
          await page.waitForTimeout(200);
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
            const seen = st.players[st.party[0]].seen as ArrayLike<number>;
            const a = st.area.actors.find((x) => x.id !== st.players[st.party[0]].actorId && x.hp > 0 && seen[x.pos.y * w + x.pos.x] === 2);
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
            cl.notice = await page.evaluate(() => {
              const n = document.querySelector<HTMLElement>('.aw-gfx-lost');
              if (!n || n.hidden || !n.offsetHeight) return null;
              const r = n.getBoundingClientRect();
              return { text: n.innerText.replace(/\s+/g, ' ').slice(0, 160), box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], layer: window.__anyworld!.ui.layer() };
            });
            await shot('ctx-lost');
            // a tap on Wait while lost: the notice should take it (no blind turns)
            const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
            const wb = await page.locator('.aw-ctx:not([hidden]) .aw-ctx-btn[data-action="wait"]').first().boundingBox().catch(() => null);
            if (wb) await page.touchscreen.tap(wb.x + wb.width / 2, wb.y + wb.height / 2);
            await page.waitForTimeout(300);
            cl.turnWhileLost = wb ? (await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)) - t0 : 'no wait button';
            await page.waitForTimeout(5400);
            cl.reloadOfferedAfter5s = await page.locator('.aw-gfx-reload').isVisible().catch(() => false);
            await shot('ctx-lost-5s');
            await page.evaluate(() => (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext());
            await page.waitForTimeout(1500);
            cl.after = await stats(page, 'restored');
            cl.noticeAfterRestore = await page.locator('.aw-gfx-lost').isVisible().catch(() => false);
            cl.layerAfterRestore = await layer(page);
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
            expect.soft(cl.notice, 'a lost context is told to the player').not.toBeNull();
            expect.soft(cl.noticeAfterRestore, 'the notice goes away on restore').toBe(false);
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
        // the bot repeating a decision that touch cannot carry out: note it, then step aside so the run goes on
        if (d.turn === stallTurn) stall++;
        else {
          stallTurn = d.turn;
          stall = 0;
        }
        if (stall >= 6) {
          if (stall === 6) rep.notes.push(`stalled at turn ${d.turn} on bot action ${JSON.stringify(d.a)} from ${JSON.stringify(d.me)}`);
          const dirs = Object.keys(DELTA);
          const dir = dirs[(stall + i) % dirs.length];
          const [sx, sy] = DELTA[dir];
          const pt = await tilePoint(page, { x: d.me.x + sx, y: d.me.y + sy });
          if (stall % 3 === 0 || !pt.onMap) await tapCtx(page, 'wait');
          else await page.touchscreen.tap(pt.x, pt.y);
          await page.waitForTimeout(120);
          continue;
        }
        const a = d.a as { type: string; dir?: string; targetId?: string; slot?: number; target?: { x: number; y: number }; pos?: { x: number; y: number } };
        let done = false;
        if (a.type === 'move' && a.dir) {
          const [dx, dy] = DELTA[a.dir];
          const pt = await tilePoint(page, { x: d.me.x + dx, y: d.me.y + dy });
          if (pt.onMap && pt.hits) {
            lastTap = { kind: 'move', at: [Math.round(pt.x), Math.round(pt.y)], turn: d.turn };
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
              lastTap = { kind: 'attack', at: [Math.round(pt.x), Math.round(pt.y)], turn: d.turn };
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
            const tid = a.target ? await page.evaluate((t) => window.__anyworld!.controller!.session.state.area.actors.find((x) => x.hp > 0 && x.pos.x === t.x && x.pos.y === t.y)?.id ?? null, a.target) : null;
            const pt = a.target ? await tilePoint(page, a.target, tid ?? undefined) : null;
            if (pt?.onMap) await page.touchscreen.tap(pt.x, pt.y);
            else await page.locator('.aw-hotbar-slots .aw-slot').nth(a.slot).tap();
            await page.waitForTimeout(150);
            if ((await layer(page)) === 'target' && aimNotes++ < 6) {
              const why = await page.evaluate(([t, x, y]) => {
                const app = window.__anyworld!;
                const s = app.controller!.session;
                return { aim: s.aim(), pick: x === null ? null : app.renderer!.pick(x as number, y as number), toasts: Array.from(document.querySelectorAll('.aw-toast')).map((e) => (e as HTMLElement).innerText).slice(-2), me: s.player().pos, target: t };
              }, [a.target, pt?.onMap ? pt.x : null, pt?.onMap ? pt.y : null] as const);
              rep.notes.push(`aim tap did not fire (slot ${a.slot}, tile hit ${pt?.hits}): ${JSON.stringify(why)}`);
              if (aimNotes === 1) await shot('aim-miss');
            }
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
        if (i % 4 === 0 && (await layer(page)) === 'game') {
          await page.waitForTimeout(1300);
          const x = await extraAudit(page);
          addUnique(rep.hiddenActors, x.hidden, `turn ${d.turn}`);
          addUnique(rep.clipped, x.clipped, `turn ${d.turn}`);
          if (x.hidden.some((h) => h.startsWith('hostile')) && !shotsTaken.has('hidden')) {
            shotsTaken.add('hidden');
            await shot('hidden-hostile');
          }
          if (x.clipped.length && !shotsTaken.has('clipped')) {
            shotsTaken.add('clipped');
            await shot('clipped');
          }
        }
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
                seen: (s.state.players[s.state.party[0]].seen as ArrayLike<number>)[t.y * w + t.x],
                path: travel.travelPath(s.state, t),
                actorThere: s.state.area.actors.some((x: { hp: number; pos: { x: number; y: number } }) => x.hp > 0 && x.pos.x === t.x && x.pos.y === t.y),
                actor: (() => {
                  const x = s.state.area.actors.find((q: { hp: number; pos: { x: number; y: number } }) => q.hp > 0 && q.pos.x === t.x && q.pos.y === t.y) as { id: string; defId: string; faction: string; allyOf?: string } | undefined;
                  if (!x) return null;
                  const legal = (eng.legalActions(s.state) as { type: string; targetId?: string }[]).filter((l) => l.targetId === x.id).map((l) => l.type);
                  return { def: x.defId, faction: x.faction, allyOf: x.allyOf, legal, meaning: window.__anyworld!.controller!.tapMeaning(t) };
                })(),
                pickAtTile: (() => {
                  const r = window.__anyworld!.renderer!;
                  const sp = r.tileToScreen(t);
                  return r.pick(sp.x, sp.y);
                })(),
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
      rep.notes.push(`aims cancelled after a tap found no valid target: ${targetMiss}`);
      rep.notes.push(`ctx buttons covered by a panel: ${JSON.stringify(COVERED.slice(0, 8))} (${COVERED.length} total)`);
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
        // "New world" → start screen at the top → another demo → its prologue and how-to-play card before any move
        const sr: Record<string, unknown> = {};
        await page.locator('.aw-end .aw-btn-primary').first().tap();
        await page.waitForTimeout(800);
        sr.layerAfterNewWorld = await layer(page);
        sr.startScroll = await startScroll(page);
        await shot('5-new-world');
        const next = c.lang === 'nb' ? 'viking-lawspeaker-althing-nb' : 'abstract-yellow-triangle';
        sr.world = next;
        if (await tapDemo(page, cdp, next)) {
          await page.waitForFunction(() => ['narration', 'game', 'help'].includes(window.__anyworld?.ui.layer() ?? ''), null, { timeout: 60000 });
          await page.waitForTimeout(900);
          sr.firstLayer = await layer(page);
          sr.turn = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
          await shot('6-second-run-open');
          const narr = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
          let k = 0;
          while (k++ < 6 && (await narr.isVisible().catch(() => false))) {
            await narr.tap();
            await page.waitForTimeout(300);
          }
          sr.onboardingBeforeMove = await page.locator('.aw-onboard:not([hidden])').isVisible().catch(() => false);
          await shot('7-second-run-onboarding');
          // safe-area / layout audit on the second world too
          await clearIntro(page);
          await page.waitForTimeout(400);
          if ((await layer(page)) === 'game') {
            await audit('second run');
            rep.stats.push(await stats(page, 'second run'));
          }
          expect.soft(sr.firstLayer, 'second run opens on its prologue').toBe('narration');
          expect.soft(sr.onboardingBeforeMove, 'how-to-play card before the first move').toBe(true);
        } else sr.note = `no demo card for ${next}`;
        expect.soft(sr.startScroll, 'start screen at the top after New world').toEqual([]);
        rep.secondRun = sr;
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
      for (const a of st.area.actors) if (a.id !== st.players[st.party[0]].actorId && a.hp > 0) out.push({ ...a.pos, id: a.id });
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
        return ((st.players[st.party[0]].seen as ArrayLike<number>)[p.y * st.area.map.width + p.x] ?? 0) === 2;
      }, tg);
      if (!tip && known) problems.push(`long-press on ${JSON.stringify(tg)} showed no inspect card`);
      await page.locator('.aw-strip').tap();
      await page.waitForTimeout(250);
    }
    mkdirSync(REPORT, { recursive: true });
    writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-longpress.json`, JSON.stringify({ targets, problems }, null, 2));
    expect.soft(problems).toEqual([]);
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
    writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-inspect-dismiss.json`, JSON.stringify(out, null, 2));
  });
});

// Long-press on an actor's body (round 2): after the camera and the actor have settled, a long-press at
// several heights of the drawn actor must open THAT actor's card, not the floor tile next to it.
test.describe('probes-longpress-actor', () => {
  test.use(phone('iPhone 15'));

  test('long-press on a drawn actor opens its card', async ({ page }) => {
    test.setTimeout(300000);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pt-init')) {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'en');
        sessionStorage.setItem('pt-init', '1');
      }
    });
    await page.goto('/?world=fantasy-retired-mimic&seed=4');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await clearIntro(page);
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(async (root) => {
      const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
      (window as unknown as { __mb: unknown }).__mb = { bot: sim.botByName('explorer'), mem: sim.newMemory(4) };
    }, ROOT);
    const results: unknown[] = [];
    const tested = new Set<string>();
    for (let k = 0; k < 160 && results.length < 12; k++) {
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
      await page.waitForTimeout(80);
      if (k % 6 !== 0) continue;
      await page.waitForTimeout(900);
      const actors = await page.evaluate(() => {
        const s = window.__anyworld!.controller!.session;
        const st = s.state;
        const w = st.area.map.width;
        const seen = st.players[st.party[0]].seen as ArrayLike<number>;
        return st.area.actors
          .filter((a) => a.hp > 0 && a.id !== st.players[st.party[0]].actorId && seen[a.pos.y * w + a.pos.x] === 2)
          .map((a) => ({ id: a.id, pos: a.pos, name: s.describeAt(a.pos).actor?.name ?? '?' }));
      });
      for (const a of actors) {
        if (tested.has(a.id)) continue;
        tested.add(a.id);
        for (const frac of [0.2, 0.45, 0.7]) {
          const pt = await page.evaluate(([id, f]) => {
            const r = window.__anyworld!.renderer!;
            const at = r.actorScreen(id as string, f as number);
            if (!at) return null;
            const el = document.elementFromPoint(at.x, at.y);
            return { ...at, onMap: !!el && !!el.closest('#game-canvas'), pick: r.pick(at.x, at.y) };
          }, [a.id, frac] as const);
          if (!pt || !pt.onMap) continue;
          await longPress(cdp, pt.x, pt.y, 700);
          await page.waitForTimeout(250);
          const tip = page.locator('.aw-tooltip.is-visible');
          const text = (await tip.isVisible().catch(() => false)) ? (await tip.innerText()).replace(/\s+/g, ' ').slice(0, 80) : null;
          const ok = !!text && text.includes(a.name);
          results.push({ actor: a.name, pos: a.pos, frac, at: [Math.round(pt.x), Math.round(pt.y)], pick: pt.pick, ok, text });
          if (!ok && !tested.has('shot')) {
            tested.add('shot');
            await page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-probe-longpress-actor-miss.png` });
          }
          await page.locator('.aw-strip').tap();
          await page.waitForTimeout(200);
        }
      }
    }
    mkdirSync(REPORT, { recursive: true });
    writeFileSync(`${REPORT}/m5-mobile-pt-${ROUND}-probe-longpress-actor.json`, JSON.stringify(results, null, 2));
  });
});

// Occlusion probe (round 2): a hostile standing on the tile right behind the player (the neighbour drawn
// highest on the screen) is hidden by the player's own model. Can a touch player still tap it to attack?
// The probe sweeps a grid of screen points around the hostile and asks the renderer what each one picks,
// then taps the hostile's tile centre and its body and records what the game did.
for (const pc of [
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'fantasy-retired-mimic', seed: 4 },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'heist-silent-vault', seed: 21 },
  { id: 'pixel7-landscape', device: 'Pixel 7 landscape', world: 'detective-sugar-hotel', seed: 13 },
]) {
  test.describe(`probes-occluded-${pc.id}`, () => {
    test.use(phone(pc.device));
    test(`hostile behind the player can be tapped (${pc.world})`, async ({ page }) => {
      test.setTimeout(240000);
      await page.addInitScript(() => {
        if (!sessionStorage.getItem('pt-init')) {
          localStorage.clear();
          localStorage.setItem('anyworld.lang.v1', 'en');
          sessionStorage.setItem('pt-init', '1');
        }
      });
      await page.goto(`/?world=${pc.world}&seed=${pc.seed}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
      await page.waitForTimeout(900);
      await clearIntro(page);
      const out: Record<string, unknown> = { world: pc.world };
      // the neighbour drawn highest on screen that is floor and free; a hostile is moved there
      const placed = await page.evaluate(async () => {
        const app = window.__anyworld!;
        const c = app.controller!;
        const s = c.session;
        const st = s.state;
        const me = s.player().pos;
        const r = app.renderer!;
        const w = st.area.map.width;
        const hostile = st.area.actors.find((a) => a.hp > 0 && a.faction === 'hostile' && a.id !== st.players[st.party[0]].actorId);
        if (!hostile) return null;
        let best: { x: number; y: number; sy: number } | null = null;
        for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]]) {
          const p = { x: me.x + dx, y: me.y + dy };
          const t = st.area.map.tiles[p.y * w + p.x] as { kind: string };
          if (!t || t.kind !== 'floor') continue;
          if (st.area.actors.some((a) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
          const sp = r.tileToScreen(p);
          if (!best || sp.y < best.sy) best = { ...p, sy: sp.y };
        }
        if (!best) return null;
        const id = hostile.id;
        await c.setStateForTest((ns) => {
          const a = ns.area.actors.find((x) => x.id === id)!;
          a.pos = { x: best!.x, y: best!.y };
          const seen = ns.players[ns.party[0]].seen as number[];
          seen[best!.y * w + best!.x] = 2;
        });
        return { id, name: s.describeAt({ x: best.x, y: best.y }).actor?.name ?? hostile.defId, pos: { x: best.x, y: best.y }, me };
      });
      if (!placed) {
        out.note = 'no hostile / free tile behind the player';
        writeFileSync(`${REPORT}/m5-mobile-pt-${ROUND}-probe-occluded-${pc.id}.json`, JSON.stringify(out, null, 2));
        return;
      }
      out.placed = placed;
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-probe-occluded-${pc.id}.png` });
      // a grid of points around where the hostile is drawn: which pick its tile?
      out.sweep = await page.evaluate((p) => {
        const r = window.__anyworld!.renderer!;
        const st = window.__anyworld!.controller!.session.state;
        const c0 = r.actorScreen(p.id, 0.45) ?? r.tileToScreen(p.pos);
        const tile = r.tileToScreen(p.pos);
        let hits = 0;
        let player = 0;
        let total = 0;
        const hitPts: number[][] = [];
        for (let dy = -60; dy <= 60; dy += 4)
          for (let dx = -40; dx <= 40; dx += 4) {
            const x = c0.x + dx;
            const y = c0.y + dy;
            const el = document.elementFromPoint(x, y);
            if (!el || !el.closest('#game-canvas')) continue;
            total++;
            const k = r.pick(x, y);
            if (k && k.x === p.pos.x && k.y === p.pos.y) {
              hits++;
              if (hitPts.length < 6) hitPts.push([Math.round(x), Math.round(y)]);
            }
            const me = st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.pos;
            if (k && k.x === me.x && k.y === me.y) player++;
          }
        const pickTile = r.pick(tile.x, tile.y);
        const pickBody = r.pick(c0.x, c0.y);
        return { hits, player, total, hitPts, tileCentre: [Math.round(tile.x), Math.round(tile.y)], pickTile, body: [Math.round(c0.x), Math.round(c0.y)], pickBody };
      }, placed);
      // a real tap where the hostile is drawn (its body), then on its tile centre
      const before = await page.evaluate(() => ({ turn: window.__anyworld!.controller!.session.state.turn, log: window.__anyworld!.controller!.session.state.log.length }));
      const sw = out.sweep as { body: number[]; tileCentre: number[] };
      await page.touchscreen.tap(sw.body[0], sw.body[1]);
      await page.waitForTimeout(500);
      const after = await page.evaluate((n) => {
        const s = window.__anyworld!.controller!.session;
        return { turn: s.state.turn, me: s.player().pos, newLog: (s.state.log as { text: string }[]).slice(n).map((l) => l.text).slice(0, 4), toasts: Array.from(document.querySelectorAll('.aw-toast')).map((e) => (e as HTMLElement).innerText), layer: window.__anyworld!.ui.layer() };
      }, before.log);
      out.tapBody = after;
      // round 3: the tap must do something visible: a turn (the attack) or at least feedback
      expect.soft(after.turn > before.turn || after.toasts.length > 0, `tap on hostile behind the player did something: ${JSON.stringify(after)}`).toBe(true);
      expect.soft((out.sweep as { hits: number }).hits, 'some points around the drawn hostile pick its tile').toBeGreaterThan(0);
      await page.screenshot({ path: `${OUT}/pt-mobile-${ROUND}-probe-occluded-${pc.id}-after-tap.png` });
      mkdirSync(REPORT, { recursive: true });
      writeFileSync(`${REPORT}/m5-mobile-pt-${ROUND}-probe-occluded-${pc.id}.json`, JSON.stringify(out, null, 2));
    });
  });
}
