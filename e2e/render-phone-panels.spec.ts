/**
 * Phones (M5 review round 2):
 *  - hostiles under the bottom panels (issues/M5-phone-hostiles-under-panels.md): once the camera
 *    settles, no visible actor's feet / body point resolves to a page element instead of the map, even
 *    when a hostile is put right where the log ticker, the context row or the hotbar is drawn.
 *  - a short hostile behind a tall player model (issues/M5-hostile-behind-player-untappable.md): a tap
 *    where it stands picks its tile and attacks it; the player model is drawn see-through meanwhile.
 * Screenshots go to test-results/shots/M5-render/.
 * Run: xvfb-run -a npx playwright test -c tests/render/playwright.render.config.ts e2e/render-phone-panels.spec.ts
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'test-results/shots/M5-render';
mkdirSync(OUT, { recursive: true });

function phone(name: string) {
  const { defaultBrowserType: _ignored, ...rest } = devices[name]!;
  return rest;
}

async function start(page: Page, world: string, seed: number, lang: string) {
  await page.addInitScript((l) => {
    if (!sessionStorage.getItem('rp-init')) {
      try {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', l);
      } catch {
        /* storage blocked */
      }
      sessionStorage.setItem('rp-init', '1');
    }
    // no Vite HMR socket: other agents' edits must not reload the page mid-test
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, lang);
  await page.goto(`/?world=${world}&seed=${seed}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(700);
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

/**
 * wait until the camera has come to rest and stays there for longer than two of the renderer's page
 * checks (it looks for panels over actors every 500 ms while resting, and may then move again)
 */
async function settle(page: Page) {
  const snap = () =>
    page.evaluate(() => {
      const r = window.__anyworld!.renderer!;
      const rig = r.rig;
      const resting = !r.anim.busy && Math.abs(rig.dist - rig.distTarget) < 1e-3 && rig.pan.x === rig.panTarget.x && rig.pan.y === rig.panTarget.y;
      return resting ? `${rig.distTarget.toFixed(3)}|${rig.pan.x.toFixed(1)},${rig.pan.y.toFixed(1)}|${rig.yawStep}` : null;
    });
  let last: string | null = null;
  let since = Date.now();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const s = await snap();
    if (s === null || s !== last) {
      last = s;
      since = Date.now();
    } else if (Date.now() - since > 1300) return;
    await page.waitForTimeout(150);
  }
  throw new Error('the camera never came to rest');
}

/** visible actors whose every probe point is covered by a page element (the review's audit) */
async function hiddenActors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const st = app.controller!.session.state;
    const r = app.renderer!;
    const w = st.area.map.width;
    const seen = st.area.seen as ArrayLike<number>;
    const hidden: string[] = [];
    for (const a of st.area.actors) {
      if (a.hp <= 0 || a.id === st.player.actorId || seen[a.pos.y * w + a.pos.x] !== 2) continue;
      const pts = [r.actorScreen(a.id, 0.45), r.tileToScreen(a.pos)].filter(Boolean) as { x: number; y: number }[];
      const on = pts.filter((p) => p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight);
      if (!on.length) continue;
      const covers = on.map((p) => document.elementFromPoint(p.x, p.y)).filter((el) => !!el && !el.closest('#game-canvas'));
      if (covers.length === on.length) hidden.push(`${a.faction}:${a.defId} at ${a.pos.x},${a.pos.y} under ${String((covers[0] as HTMLElement).className).split(' ')[0]}`);
    }
    return hidden;
  });
}

/**
 * Free, visible floor tiles whose centre is drawn under a page panel right now, at most one per panel
 * (the panel's first class), nearest to the player first.
 */
async function tilesUnderPanels(page: Page) {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const st = app.controller!.session.state;
    const r = app.renderer!;
    const w = st.area.map.width;
    const h = st.area.map.height;
    const seen = st.area.seen as ArrayLike<number>;
    const me = app.controller!.session.player().pos;
    const out = new Map<string, { x: number; y: number; panel: string; d: number }>();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!seen[y * w + x]) continue;
        const t = st.area.map.tiles[y * w + x] as { kind: string };
        if (!t || t.kind !== 'floor') continue;
        if (st.area.actors.some((a) => a.hp > 0 && a.pos.x === x && a.pos.y === y)) continue;
        if (st.area.items.some((i) => i.pos.x === x && i.pos.y === y)) continue;
        const s = r.tileToScreen({ x, y });
        if (s.x <= 0 || s.y <= 0 || s.x >= innerWidth || s.y >= innerHeight) continue;
        const el = document.elementFromPoint(s.x, s.y) as HTMLElement | null;
        if (!el || el.closest('#game-canvas')) continue;
        const panel = (el.closest('.aw-hud, .aw-strip, .aw-goal, .aw-log, .aw-ctx, .aw-hotbar, .aw-map-tools, .aw-panel') as HTMLElement | null) ?? el;
        const key = String(panel.className).split(' ')[0]!;
        const d = Math.max(Math.abs(x - me.x), Math.abs(y - me.y));
        const prev = out.get(key);
        if (!prev || d < prev.d) out.set(key, { x, y, panel: key, d });
      }
    return [...out.values()].sort((a, b) => a.d - b.d);
  });
}

async function moveHostile(page: Page, to: { x: number; y: number }) {
  return page.evaluate(async (p) => {
    const app = window.__anyworld!;
    const c = app.controller!;
    const st = c.session.state;
    const pid = st.player.actorId;
    const foe = st.area.actors.find((a) => a.hp > 0 && a.faction === 'hostile' && a.id !== pid) ?? st.area.actors.find((a) => a.hp > 0 && a.id !== pid);
    if (!foe) return null;
    const id = foe.id;
    const w = st.area.map.width;
    await c.setStateForTest((ns) => {
      const a = ns.area.actors.find((x) => x.id === id)!;
      a.pos = { x: p.x, y: p.y };
      (ns.area.seen as number[])[p.y * w + p.x] = 2;
    });
    return { id, defId: foe.defId };
  }, to);
}

const CASES = [
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'fantasy-retired-mimic', seed: 4, lang: 'en' },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'nb-russetid-bussen', seed: 3, lang: 'nb' },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'cyberpunk-rooftop-yams', seed: 7, lang: 'en' },
];

for (const c of CASES) {
  test.describe(`phone panels ${c.id}`, () => {
    test.use(phone(c.device));
    test(`no visible hostile stays under a panel (${c.world})`, async ({ page }) => {
      test.setTimeout(180000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await start(page, c.world, c.seed, c.lang);
      await settle(page);
      const h0 = await hiddenActors(page);
      if (h0.length) {
        await page.screenshot({ path: `${OUT}/phone-panels-${c.id}-fail-start.png` });
      }
      expect(h0, 'at the start').toEqual([]);
      // put a hostile where a panel is drawn over the map right now (when the whole visible room
      // already fits between the panels, there is no such tile and the start check above is the test)
      const spots = await tilesUnderPanels(page);
      for (const spot of spots.slice(0, 3)) {
        const moved = await moveHostile(page, spot);
        if (!moved) break;
        await settle(page);
        const hidden = await hiddenActors(page);
        if (hidden.length) await page.screenshot({ path: `${OUT}/phone-panels-${c.id}-fail-${spot.panel}.png` });
        expect(hidden, `a hostile put under ${spot.panel} at ${spot.x},${spot.y}`).toEqual([]);
      }
      await page.screenshot({ path: `${OUT}/phone-panels-${c.id}.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}

test.describe('hostile behind a tall player model', () => {
  test.use(phone('iPhone 15'));
  test('can be tapped and attacked, and the player is drawn see-through', async ({ page }) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await start(page, 'fantasy-retired-mimic', 4, 'en');
    await settle(page);
    // the free neighbour drawn highest on screen (behind the player model)
    const behind = await page.evaluate(() => {
      const app = window.__anyworld!;
      const st = app.controller!.session.state;
      const me = app.controller!.session.player().pos;
      const r = app.renderer!;
      const w = st.area.map.width;
      let best: { x: number; y: number; sy: number } | null = null;
      for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]] as const) {
        const p = { x: me.x + dx, y: me.y + dy };
        const t = st.area.map.tiles[p.y * w + p.x] as { kind: string } | undefined;
        if (!t || t.kind !== 'floor') continue;
        if (st.area.actors.some((a) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
        const sp = r.tileToScreen(p);
        if (!best || sp.y < best.sy) best = { ...p, sy: sp.y };
      }
      return best;
    });
    expect(behind).not.toBeNull();
    const foe = await moveHostile(page, behind!);
    expect(foe).not.toBeNull();
    await settle(page);
    const probe = await page.evaluate(
      ({ id, pos }) => {
        const app = window.__anyworld!;
        const r = app.renderer!;
        const st = app.controller!.session.state;
        const me = st.area.actors.find((a) => a.id === st.player.actorId)!.pos;
        const tile = r.tileToScreen(pos);
        const bodyAt = r.actorScreen(id, 0.45) ?? tile;
        let hits = 0;
        let player = 0;
        for (let dy = -60; dy <= 60; dy += 4)
          for (let dx = -40; dx <= 40; dx += 4) {
            const x = bodyAt.x + dx;
            const y = bodyAt.y + dy;
            const el = document.elementFromPoint(x, y);
            if (!el || !el.closest('#game-canvas')) continue;
            const k = r.pick(x, y);
            if (k && k.x === pos.x && k.y === pos.y) hits++;
            if (k && k.x === me.x && k.y === me.y) player++;
          }
        return { tile, bodyAt, pickTile: r.pick(tile.x, tile.y), pickBody: r.pick(bodyAt.x, bodyAt.y), hits, player, seeThrough: r.playerIsSeeThrough, hides: r.playerHidesNeighbour() };
      },
      { id: foe!.id, pos: behind! },
    );
    await page.screenshot({ path: `${OUT}/phone-behind-player.png` });
    expect(probe.pickTile).toEqual({ x: behind!.x, y: behind!.y });
    expect(probe.pickBody).toEqual({ x: behind!.x, y: behind!.y });
    // the hostile's tile is a real target now, not a single lucky pixel
    expect(probe.hits).toBeGreaterThan(20);
    expect(probe.seeThrough).toBe(probe.hides);
    // a real tap where it is drawn attacks it
    const before = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    await page.touchscreen.tap(probe.bodyAt.x, probe.bodyAt.y);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    expect(after).toBeGreaterThan(before);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/**
 * issues/M5-tap-behind-player-ignored.md: the empty floor tile drawn right behind a tall player model.
 * Its centre lies on the model's head; pick() used to return the player's own tile, so a tap did nothing.
 */
const BEHIND_EMPTY = [
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'detective-sugar-hotel', seed: 5 },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'fantasy-retired-mimic', seed: 4 },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'nb-troll-direktoratet', seed: 6 },
];
for (const d of BEHIND_EMPTY) {
  test.describe(`empty tile behind the player model (${d.id})`, () => {
    test.use(phone(d.device));
    test(`a tap on its centre picks it and walks there (${d.world})`, async ({ page }) => {
      test.setTimeout(180000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await start(page, d.world, d.seed, 'en');
      await settle(page);
      const probe = await page.evaluate(() => {
        const app = window.__anyworld!;
        const st = app.controller!.session.state;
        const me = app.controller!.session.player().pos;
        const r = app.renderer!;
        const w = st.area.map.width;
        let best: { x: number; y: number; sy: number } | null = null;
        for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]] as const) {
          const p = { x: me.x + dx, y: me.y + dy };
          const t = st.area.map.tiles[p.y * w + p.x] as { kind: string } | undefined;
          if (!t || t.kind !== 'floor') continue;
          if (st.area.actors.some((a) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
          const sp = r.tileToScreen(p);
          if (!best || sp.y < best.sy) best = { ...p, sy: sp.y };
        }
        if (!best) return null;
        const target = { x: best.x, y: best.y };
        const at = r.tileToScreen(target);
        const el = document.elementFromPoint(at.x, at.y);
        // the player's own feet still pick the player's tile
        const feet = r.tileToScreen(me);
        return { me: { ...me }, target, at, onMap: !!el && !!el.closest('#game-canvas'), pick: r.pick(at.x, at.y), ground: r.screenToTile(at.x, at.y), feetPick: r.pick(feet.x, feet.y), turn: st.turn };
      });
      expect(probe).not.toBeNull();
      expect(probe!.onMap).toBe(true);
      expect(probe!.ground).toEqual(probe!.target);
      expect(probe!.pick).toEqual(probe!.target);
      expect(probe!.feetPick).toEqual(probe!.me);
      await page.touchscreen.tap(probe!.at.x, probe!.at.y);
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => {
        const s = window.__anyworld!.controller!.session;
        return { turn: s.state.turn, me: s.player().pos };
      });
      await page.screenshot({ path: `${OUT}/phone-behind-player-empty-${d.id}.png` });
      expect(after.me).toEqual(probe!.target);
      expect(after.turn).toBeGreaterThan(probe!.turn);
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}
