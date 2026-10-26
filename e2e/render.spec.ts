/**
 * Renderer visual checks: the model gallery and every area of every fixture world render without
 * console errors; screenshots go to docs/progress/M2/ for review.
 * Run: xvfb-run -a npx playwright test e2e/render.spec.ts
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });

const worldsDir = join(process.cwd(), 'content/worlds');
const FIXTURES = readdirSync(worldsDir)
  .filter((f) => f.startsWith('fixture-') && f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

function areaCount(name: string): number {
  const w = JSON.parse(readFileSync(join(worldsDir, `${name}.json`), 'utf8'));
  return Array.isArray(w.areas) ? w.areas.length : 0;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  // a few frames for shadows / textures to settle
  await page.waitForTimeout(400);
}

test.describe.configure({ mode: 'serial' });

for (const world of FIXTURES) {
  test(`gallery renders ${world}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/dev/gallery.html?world=${world}`);
    await waitReady(page);
    await page.screenshot({ path: `${OUT}/gallery-${world}.png` });
    await page.goto(`/dev/gallery.html?world=${world}&section=characters`);
    await waitReady(page);
    await page.screenshot({ path: `${OUT}/characters-${world}.png` });
    expect(errors, errors.join('\n')).toEqual([]);
    const title = await page.textContent('#title');
    expect(title).not.toContain('Failed');
  });

  const n = areaCount(world);
  for (let area = 0; area < n; area++) {
    test(`area ${area} renders ${world}`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(`/dev/area.html?world=${world}&area=${area}&seed=3`);
      await waitReady(page);
      await page.screenshot({ path: `${OUT}/area-${world}-${area}.png` });
      const title = await page.textContent('#title');
      expect(title).not.toContain('Failed');
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }

  test(`animations, camera and picking work in ${world}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/dev/area.html?world=${world}&area=0&seed=3`);
    await waitReady(page);

    // demo turn: attacks, damage numbers, vfx, death, heal — must resolve quickly
    const ms = await page.evaluate(async () => {
      const t0 = performance.now();
      const p = window.__dev!.demo();
      await new Promise((r) => setTimeout(r, 140));
      return { started: performance.now() - t0, done: await p.then(() => performance.now() - t0) };
    });
    expect(ms.done).toBeLessThan(1500);
    await page.screenshot({ path: `${OUT}/anim-${world}.png` });

    // skipping resolves immediately
    const skipped = await page.evaluate(async () => {
      const t0 = performance.now();
      const p = window.__dev!.demo();
      window.__dev!.renderer.skipAnimations();
      await p;
      return performance.now() - t0;
    });
    expect(skipped).toBeLessThan(300);

    // a few moves, then rotate the camera and check screenToTile/tileToScreen agree
    await page.evaluate(async () => {
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0]]) await window.__dev!.move(dx, dy);
    });
    await page.evaluate(() => window.__dev!.renderer.rotateCamera(1));
    await page.waitForTimeout(700);
    const roundTrip = await page.evaluate(() => {
      const r = window.__dev!.renderer;
      const s = window.__dev!.state;
      const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!.pos;
      const sc = r.tileToScreen(p);
      return { p, back: r.screenToTile(sc.x, sc.y) };
    });
    expect(roundTrip.back).toEqual(roundTrip.p);
    await page.evaluate(() => {
      const s = window.__dev!.state;
      const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!.pos;
      window.__dev!.renderer.highlightTiles([{ x: p.x + 1, y: p.y }, { x: p.x + 2, y: p.y }], '#7fe3ff');
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/rotated-${world}.png` });

    // close-up with the original camera direction (model readability at max zoom)
    await page.evaluate(() => {
      const r = window.__dev!.renderer;
      r.highlightTiles([]);
      r.rotateCamera(-1);
      r.zoom(-20);
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/closeup-${world}.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

// M1 issue: overhead hp bars were unreadable (the opaque fill was drawn under the translucent background)
test('hp bar fill is drawn on top of its background', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/dev/area.html?world=${FIXTURES[0]}&area=0&seed=3`);
  await waitReady(page);
  const res = await page.evaluate(async () => {
    const d = window.__dev!;
    const next = structuredClone(d.state);
    const p = next.area.actors.find((a) => a.id === next.players[next.party[0]].actorId)!;
    p.hp = Math.max(1, Math.round(p.maxHp * 0.625)); // > 60 %: the green fill
    d.state = next;
    await d.renderer.sync(next, []);
    d.renderer.skipAnimations();
    d.renderer.zoom(-20);
    d.renderer.rig.settle();
    const bar = d.renderer.hpBarScreen(p.id);
    if (!bar) return null;
    // sample a few pixels along the filled part's centre line
    const samples = [-6, -3, 0, 3, 6].map((dx) => d.renderer.samplePixel(bar.x + dx, bar.y));
    return { bar, samples };
  });
  expect(res, 'player hp bar should be visible').not.toBeNull();
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  // #5fe08a = (95, 224, 138); the old bug showed near-black teal (~ 20, 45, 35)
  const green = res!.samples.filter((h) => {
    const [r, g, b] = rgb(h);
    return g > 170 && g - r > 70 && g - b > 40;
  });
  expect(green.length, `samples ${res!.samples.join(' ')}`).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: `${OUT}/hpbar-${FIXTURES[0]}.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

// M1 issue: the cut-away did not clear door frames / walls hiding the player in a doorway or an adjacent enemy
for (const world of FIXTURES) {
  test(`cut-away clears doorways and adjacent actors in ${world}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/dev/area.html?world=${world}&area=0&seed=3`);
    await waitReady(page);
    const res = await page.evaluate(async () => {
      const d = window.__dev!;
      const next = structuredClone(d.state);
      const map = next.area.map;
      const W = map.width;
      const door = map.tiles.findIndex((t) => t.kind === 'door' || t.kind === 'door_open');
      if (door < 0) return { skipped: true as const };
      map.tiles[door].kind = 'door_open';
      const p = next.area.actors.find((a) => a.id === next.players[next.party[0]].actorId)!;
      p.pos = { x: door % W, y: Math.floor(door / W) };
      // an enemy on a free tile next to the player
      const other = next.area.actors.find((a) => a.id !== p.id);
      let enemyAt: { x: number; y: number } | null = null;
      if (other) {
        for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1]]) {
          const x = p.pos.x + ox;
          const y = p.pos.y + oy;
          const t = map.tiles[y * W + x];
          if (t && (t.kind === 'floor' || t.kind === 'start')) {
            other.pos = { x, y };
            enemyAt = other.pos;
            break;
          }
        }
      }
      const seen = Uint8Array.from(next.players[next.party[0]].seen as ArrayLike<number>);
      for (let y = p.pos.y - 3; y <= p.pos.y + 3; y++) for (let x = p.pos.x - 3; x <= p.pos.x + 3; x++) if (x >= 0 && y >= 0 && x < W && y < map.height) seen[y * W + x] = 2;
      next.players[next.party[0]].seen = seen;
      d.state = next;
      await d.renderer.sync(next, []);
      d.renderer.skipAnimations();
      d.renderer.rig.settle();
      d.renderer.renderNow();
      const area = (d.renderer as unknown as { area: { loweredTiles: ReadonlySet<number>; propScaleY(i: number): number; isTall(i: number): boolean } }).area;
      const lowered = area.loweredTiles;
      // every tall tile directly between the camera (south at step 0) and the enemy must be lowered
      const blockers: number[] = [];
      if (enemyAt) for (let k = 1; k <= 2; k++) {
        const i = (enemyAt.y + k) * W + enemyAt.x;
        if (enemyAt.y + k < map.height && area.isTall(i)) blockers.push(i);
      }
      return { skipped: false as const, doorLowered: lowered.has(door), doorScale: area.propScaleY(door), blockersCut: blockers.every((i) => lowered.has(i)) };
    });
    if (!res.skipped) {
      expect(res.doorLowered).toBe(true);
      expect(res.doorScale).toBeLessThan(0.3); // a low stub (STUB_HEIGHT), frame still visible
      expect(res.blockersCut).toBe(true);
      await page.waitForTimeout(900); // let the camera glide onto the moved player
      await page.screenshot({ path: `${OUT}/cutaway-door-${world}.png` });
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

// M1 issue: in dark areas, enemies the engine counts as visible were not drawn (attacked by an
// invisible shooter). Ship area 1 "The Ductworks" (ambient 0.2, fog 0.06): an enemy 5 tiles from the
// player on a clear line in each direction must be on screen, unoccluded and lit.
test('actors on visible tiles are drawn in dark areas (fixture-ship ductworks)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/dev/area.html?world=fixture-ship&area=1&seed=7`);
  await waitReady(page);
  const res = await page.evaluate(async () => {
    const d = window.__dev!;
    const base = d.state;
    const map = base.area.map;
    const W = map.width;
    const floor = (x: number, y: number) => {
      const t = map.tiles[y * W + x];
      return !!t && (t.kind === 'floor' || t.kind === 'start');
    };
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const out: { dir: number[]; onScreen: boolean; shown: boolean; samples: string[] }[] = [];
    for (const [dx, dy] of dirs) {
      let c: { x: number; y: number } | null = null;
      for (let y = 1; y < map.height - 1 && !c; y++)
        for (let x = 1; x < W - 1 && !c; x++) {
          let ok = true;
          for (let k = 0; k <= 5; k++) if (!floor(x + dx * k, y + dy * k)) ok = false;
          if (ok) c = { x, y };
        }
      if (!c) continue;
      const next = structuredClone(base);
      const p = next.area.actors.find((a) => a.id === next.players[next.party[0]].actorId)!;
      p.pos = { ...c };
      const e = next.area.actors.find((a) => a.id !== p.id && a.faction === 'hostile')!;
      e.pos = { x: c.x + dx * 5, y: c.y + dy * 5 };
      // the engine's view: everything within 8 tiles (the straight line between them is open floor)
      const seen = new Uint8Array(map.tiles.length);
      for (let y = 0; y < map.height; y++) for (let x = 0; x < W; x++) if (Math.max(Math.abs(x - c.x), Math.abs(y - c.y)) <= 8) seen[y * W + x] = 2;
      next.players[next.party[0]].seen = seen;
      d.state = next;
      await d.renderer.sync(next, []);
      d.renderer.skipAnimations();
      d.renderer.renderNow();
      d.renderer.rig.settle();
      d.renderer.renderNow();
      const r = d.renderer as unknown as {
        actors: { views: Map<string, { root: { visible: boolean; position: { clone(): { y: number; project(c: unknown): { x: number; y: number } } } }; height: number }> };
        rig: { camera: unknown };
        gl: { domElement: HTMLCanvasElement };
      };
      const v = r.actors.views.get(e.id)!;
      const rect = r.gl.domElement.getBoundingClientRect();
      const samples: string[] = [];
      let onScreen = true;
      for (const hh of [0.3, 0.5, 0.8]) {
        const pos = v.root.position.clone();
        pos.y = v.height * hh;
        const s = pos.project(r.rig.camera);
        if (Math.abs(s.x) > 1 || Math.abs(s.y) > 1) onScreen = false;
        samples.push(d.renderer.samplePixel(rect.left + ((s.x + 1) / 2) * rect.width, rect.top + ((1 - s.y) / 2) * rect.height));
      }
      out.push({ dir: [dx, dy], onScreen, shown: v.root.visible, samples });
    }
    return out;
  });
  expect(res.length).toBe(4);
  const maxCh = (h: string) => Math.max(...[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  for (const r of res) {
    const msg = `enemy at ${r.dir} from the player: ${JSON.stringify(r)}`;
    expect(r.shown, msg).toBe(true);
    expect(r.onScreen, msg).toBe(true);
    // before the fix these were wall tops / fog / black (max channel 0x00..0x15)
    for (const s of r.samples) expect(maxCh(s), msg).toBeGreaterThanOrEqual(0x28);
  }
  await page.screenshot({ path: `${OUT}/dark-visible-actors-fixture-ship.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});
