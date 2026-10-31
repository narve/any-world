/**
 * DoD #12 (DESIGN §6b): a FULL run, played by touch alone, on phone viewports — iPhone and Pixel,
 * portrait and landscape — all the way to the end screen (issues/M5-no-touch-run-to-end.md).
 *
 * The explorer sim bot decides what to do; every decision is carried out with a tap: a tile (walk,
 * path-walk), an adjacent actor (attack / talk), a context button (pick up, move on, talk, search,
 * sneak, wait), a quick slot (+ a tap on the target), the sheets' buttons (perks, choices, dialogue,
 * trade, narration, onboarding). The automation handle is only READ (state, screen positions). The
 * run must reach the end layer (won or lost, the bot is not perfect); the cases use a world and
 * seeds the explorer wins in the engine sim (the live game master adds events, so a loss can happen). Layout invariants are checked at every area change and
 * the end screen must fit the viewport.
 * Screenshots: docs/archive/progress/M5/fullrun-<case>-*.png
 *
 * Run: xvfb-run -a npx playwright test e2e/mobile-full-run.spec.ts
 * MOBILE_BASE=http://localhost:<port> points it at another dev server; FULLRUN_MAX=<n> caps decisions.
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// review screenshots go to test-results; SHOTS_TO_DOCS=1 writes the committed milestone copies
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M5' : 'test-results/shots/mobile-full-run';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.MOBILE_BASE;
const MAX = Number(process.env.FULLRUN_MAX ?? 3000);
if (BASE) test.use({ baseURL: BASE });
test.use({ actionTimeout: 10000 });

type Device = (typeof devices)[string];
function phone(name: string): Omit<Device, 'defaultBrowserType'> {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

test.describe.configure({ mode: 'parallel' });

const FULL_RUN_CASES: { id: string; device: string; world: string; seed: number; lang: string }[] = [
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'fixture-western', seed: 9, lang: 'en' },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'fixture-western', seed: 12, lang: 'en' },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'fixture-western', seed: 5, lang: 'nb' },
  { id: 'pixel7-landscape', device: 'Pixel 7 landscape', world: 'fixture-western', seed: 8, lang: 'en' },
];

const DELTA: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** the key overlay elements stay inside the viewport, the page never scrolls sideways */
async function checkLayout(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const out: string[] = [];
    for (const s of ['.aw-hud', '.aw-strip', '.aw-goal', '.aw-log', '.aw-ctx', '.aw-hotbar-slots', '.aw-hotbar-tools']) {
      const el = document.querySelector<HTMLElement>(`.aw-game ${s}`);
      if (!el || el.closest('[hidden]') || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) out.push(`${s} ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
    // the Wait button (the only touch way to pass a turn) is always fully on screen
    const wait = document.querySelector<HTMLElement>('.aw-ctx:not([hidden]) .aw-ctx-btn[data-action="wait"]');
    if (wait) {
      const r = wait.getBoundingClientRect();
      if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1) out.push(`wait ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { out, scrollW: document.documentElement.scrollWidth, vw: innerWidth };
  });
  expect(m.out, `${where}: outside the viewport`).toEqual([]);
  expect(m.scrollW, `${where}: no horizontal scroll`).toBeLessThanOrEqual(m.vw + 1);
}

async function tilePoint(page: Page, pos: { x: number; y: number }, actorId?: string) {
  return page.evaluate(
    ([p, id]) => {
      const r = window.__anyworld!.renderer!;
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
    // a card that popped up meanwhile (GM narration, a choice) is not a layout bug
    if ((await layer(page)) !== 'game') return false;
    if (await b.count()) throw e;
    return false;
  }
  return true;
}

async function clearCards(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const narr = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (await narr.isVisible().catch(() => false)) {
      await narr.tap();
      await page.waitForTimeout(200);
      continue;
    }
    const ok = page.locator('.aw-onboard:not([hidden]) .aw-onboard-ok');
    if (await ok.isVisible().catch(() => false)) {
      await ok.tap();
      await page.waitForTimeout(200);
      continue;
    }
    break;
  }
}

/** an item action through the backpack sheet, by touch; false when it could not be done */
async function backpackAction(page: Page, slot: number, entry: string): Promise<boolean> {
  await page.locator('.aw-hotbar-tools button').first().tap();
  const bp = page.locator('.aw-backpack:not([hidden])');
  if (!(await bp.isVisible().catch(() => false))) return false;
  await bp.locator('.aw-slot').nth(slot).tap();
  const btn = bp.locator(`.aw-bp-actions [data-entry="${entry}"]:not([disabled])`);
  let ok = false;
  if (await btn.count()) {
    await btn.first().tap();
    ok = true;
  }
  if (await bp.isVisible().catch(() => false)) await bp.locator('.aw-panel-head .aw-icon-btn').tap().catch(() => undefined);
  return ok;
}

for (const c of FULL_RUN_CASES) {
  test.describe(c.id, () => {
    test.use(phone(c.device));

    test(`${c.id}: a full run of ${c.world} by touch alone, to the end screen`, async ({ page }) => {
      test.setTimeout(MAX * 1200 + 180000);
      const errors = watchErrors(page);
      await page.addInitScript((lang) => {
        if (!sessionStorage.getItem('fullrun-init')) {
          localStorage.clear();
          localStorage.setItem('anyworld.lang.v1', lang);
          // low graphics quality (what phones get on 'auto'): software GL in CI is slow
          localStorage.setItem('anyworld.settings.v1', JSON.stringify({ quality: 'low' }));
          sessionStorage.setItem('fullrun-init', '1');
        }
        // Vite HMR reloads (others edit in parallel) must not restart the run under the test
        const Native = window.WebSocket;
        const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
          if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
          return new Native(url, protocols);
        } as unknown as typeof WebSocket;
        Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
        window.WebSocket = Stub;
      }, c.lang);
      await page.goto(`/?world=${c.world}&seed=${c.seed}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1' && !!window.__anyworld?.controller, null, { timeout: 60000 });
      await page.waitForTimeout(900);
      await clearCards(page);
      expect(await layer(page)).toBe('game');
      expect(await page.evaluate(() => document.getElementById('ui-root')!.dataset.input)).toBe('touch');
      await checkLayout(page, `${c.id} start`);
      await page.screenshot({ path: `${OUT}/fullrun-${c.id}-0-start.png` });

      await page.evaluate(async ([seed, root]) => {
        const sim = await import('/@fs' + root + '/src/engine/sim/index.ts');
        (window as unknown as { __mb: unknown }).__mb = { bot: sim.botByName('explorer'), mem: sim.newMemory(seed) };
      }, [c.seed, process.cwd()] as const);

      let areaSeen = 0;
      let rotations = 0;
      let taps = 0;
      let same = 0;
      let lastKey = '';
      let offGame = 0;
      for (let i = 0; i < MAX; i++) {
        const L = await layer(page);
        if (L === 'end') break;
        offGame = L === 'game' || L === 'look' ? 0 : offGame + 1;
        if (offGame > 25) throw new Error(`${c.id}: stuck on layer ${L}`);
        // the log sheet opened by a stray tap covers the slots: a tap elsewhere closes it
        if (await page.locator('.aw-log.is-expanded').count()) {
          await page.locator('.aw-strip').tap().catch(() => undefined);
          continue;
        }
        if (L === 'narration' || L === 'help') {
          await clearCards(page);
          if (L === 'help') await page.locator('.aw-help .aw-icon-btn').first().tap().catch(() => undefined);
          continue;
        }
        if (L === 'levelup') {
          await page.locator('.aw-perk').first().tap();
          await page.waitForTimeout(120);
          continue;
        }
        if (L === 'choice') {
          await page.locator('.aw-modal:not([hidden]) .aw-option').first().tap();
          await page.waitForTimeout(120);
          continue;
        }
        if (L === 'dialogue') {
          const opt = page.locator('.aw-dialogue .aw-option:not([disabled])');
          // take what helpers offer (a gift, a heal) once in a while, otherwise leave
          if (i % 3 === 1 && (await opt.count())) await opt.first().tap();
          else await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost').tap();
          await page.waitForTimeout(120);
          continue;
        }
        if (L === 'trade') {
          await page.locator('.aw-trade .aw-dlg-foot .aw-btn-ghost').tap();
          await page.waitForTimeout(120);
          continue;
        }
        if (L === 'target') {
          const cur = await page.evaluate(() => window.__anyworld!.controller!.session.aim()?.at ?? null);
          const me = await page.evaluate(() => window.__anyworld!.controller!.session.player().pos);
          const pt = await tilePoint(page, cur ?? { x: me.x + 1, y: me.y });
          if (pt.onMap) await page.touchscreen.tap(pt.x, pt.y);
          await page.waitForTimeout(100);
          // still aiming (no valid target there): the banner's Cancel button
          if ((await layer(page)) === 'target') await page.locator('.aw-mode-banner .aw-mode-cancel').tap();
          continue;
        }
        if (L !== 'game' && L !== 'look') {
          const close = page.locator('.aw-backpack:not([hidden]) .aw-panel-head .aw-icon-btn, .aw-rules:not([hidden]) .aw-panel-head .aw-icon-btn');
          if (await close.count()) await close.first().tap();
          continue;
        }
        const d = await page.evaluate(() => {
          const mb = (window as unknown as { __mb: { bot: { decide: Function }; mem: unknown } }).__mb;
          const s = window.__anyworld!.controller!.session;
          const step = s.viewModel().game?.goal?.step.kind ?? null;
          return { a: mb.bot.decide(s.state, s.world, mb.mem), status: s.state.status, area: s.state.area.index, me: s.player().pos, step, exit: s.state.area.map.exit };
        });
        if (d.status !== 'playing') break;
        if (d.area !== areaSeen) {
          areaSeen = d.area;
          await page.waitForTimeout(400);
          await checkLayout(page, `${c.id} area ${d.area}`);
          await page.screenshot({ path: `${OUT}/fullrun-${c.id}-1-area${d.area}.png` });
        }
        if (process.env.FULLRUN_DEBUG) console.log(`[${c.id}] #${i} layer ${L} area ${d.area} at ${d.me.x},${d.me.y} ${JSON.stringify(d.a)}`);
        // the same decision from the same tile again and again (a target the tap cannot reach, a
        // tile hidden behind a panel): a player would step somewhere else
        const key = `${d.me.x},${d.me.y}|${JSON.stringify(d.a)}`;
        same = key === lastKey ? same + 1 : 0;
        lastKey = key;
        if (same >= 4) {
          same = 0;
          const dirs = await page.evaluate(async (root) => {
            const eng = await import('/@fs' + root + '/src/engine/index.ts');
            const s = window.__anyworld!.controller!.session;
            return (eng.legalActions(s.state) as { type: string; dir?: string }[]).filter((x) => x.type === 'move').map((x) => x.dir as string);
          }, process.cwd());
          let moved = false;
          for (const dir of dirs.sort(() => Math.random() - 0.5)) {
            const [dx, dy] = DELTA[dir];
            const pt = await tilePoint(page, { x: d.me.x + dx, y: d.me.y + dy });
            if (!pt.onMap || !pt.hits) continue;
            await page.touchscreen.tap(pt.x, pt.y);
            moved = true;
            break;
          }
          if (!moved) await tapCtx(page, 'wait');
          taps++;
          continue;
        }
        const a = d.a as { type: string; dir?: string; targetId?: string; slot?: number; target?: { x: number; y: number }; pos?: { x: number; y: number } };
        let done = false;
        // the way on is open and known (goal step "go to / take the exit"): when the bot only wants
        // to wander, a player would tap the exit and walk there, then tap "Move on"
        if (d.step === 'exit' && (a.type === 'move' || a.type === 'wait' || a.type === 'search')) {
          if (d.me.x === d.exit.x && d.me.y === d.exit.y) done = await tapCtx(page, 'exit');
          else {
            const pt = await tilePoint(page, d.exit);
            if (pt.onMap && pt.hits) {
              await page.touchscreen.tap(pt.x, pt.y);
              done = true;
            }
          }
        }
        if (done) {
          // handled above
        } else if (a.type === 'move' && a.dir) {
          const [dx, dy] = DELTA[a.dir];
          const pt = await tilePoint(page, { x: d.me.x + dx, y: d.me.y + dy });
          if (pt.onMap && pt.hits) {
            await page.touchscreen.tap(pt.x, pt.y);
            done = true;
          } else if (pt.onMap && rotations < 2) {
            rotations++;
            await page.locator('.aw-map-btn[data-cam="right"]').tap();
            await page.waitForTimeout(400);
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
          // a GM card may pop up over the slots between deciding and tapping: try again next round
          if (!(await page.locator('.aw-hotbar-slots .aw-slot').nth(a.slot).tap({ timeout: 3000 }).then(() => true).catch(() => false))) continue;
          await page.waitForTimeout(80);
          if ((await layer(page)) === 'target') {
            const pt = a.target ? await tilePoint(page, a.target) : null;
            if (pt?.onMap) await page.touchscreen.tap(pt.x, pt.y);
            else await page.locator('.aw-hotbar-slots .aw-slot').nth(a.slot).tap({ timeout: 3000 }).catch(() => undefined);
          }
          done = true;
        } else if ((a.type === 'equip' || a.type === 'unequip' || a.type === 'drop' || a.type === 'use') && a.slot !== undefined) {
          // backpack by touch: the bag button, the item, then its action
          done = await backpackAction(page, a.slot, a.type);
        }
        if (!done) done = await tapCtx(page, 'wait');
        taps++;
        rotations = 0;
        await page.waitForTimeout(30);
        await page.waitForFunction(() => !window.__anyworld?.controller?.session['travelDest'], null, { timeout: 8000 }).catch(() => undefined);
      }
      await expect.poll(() => layer(page), { timeout: 15000 }).toBe('end');
      const end = await page.evaluate(() => ({ status: window.__anyworld!.controller?.session.state.status ?? 'none', turn: window.__anyworld!.controller?.session.state.turn ?? 0, area: window.__anyworld!.controller?.session.state.area.index ?? 0 }));
      console.log(`[fullrun ${c.id}] ${end.status} at turn ${end.turn}, area ${end.area + 1}, ${taps} taps`);
      expect(['won', 'lost']).toContain(end.status);
      expect(taps, 'the run was played by tapping').toBeGreaterThan(50);
      // the end screen fits the phone and offers its buttons within reach
      const endBox = await page.locator('.aw-end').boundingBox();
      const vp = page.viewportSize()!;
      expect(endBox && endBox.width <= vp.width + 1, 'end screen fits the width').toBeTruthy();
      await expect(page.locator('.aw-end button').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width + 1);
      await page.screenshot({ path: `${OUT}/fullrun-${c.id}-2-end.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}
