/**
 * M3 renderer on phones (DESIGN §6b): quality tiers, draw-call budget, touch camera (pinch / twist /
 * tap picking), framing with HUD insets in portrait and landscape, and WebGL context loss recovery.
 * Screenshots go to docs/progress/M3/render-mobile-*.png for review.
 * Run: xvfb-run -a npx playwright test e2e/render-mobile.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M3' : 'test-results/shots/M3';
mkdirSync(OUT, { recursive: true });

const worldsDir = join(process.cwd(), 'content/worlds');
const FIXTURES = readdirSync(worldsDir)
  .filter((f) => f.startsWith('fixture-') && f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
const areaCount = (name: string): number => {
  const w = JSON.parse(readFileSync(join(worldsDir, `${name}.json`), 'utf8'));
  return Array.isArray(w.areas) ? w.areas.length : 0;
};

/** draw calls a fixture area may cost in one frame (both tiers) */
const DRAW_CALL_BUDGET = 250;

const IPHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const PIXEL = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function open(page: Page, query: string) {
  await page.goto(`/dev/area.html?${query}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

/** player tile, its screen position, and the screen positions of the tiles `r` steps away in 4 directions */
async function framing(page: Page, r: number) {
  return page.evaluate((r) => {
    const d = window.__dev!;
    d.renderer.skipAnimations();
    d.renderer.rig.settle();
    d.renderer.renderNow();
    const p = d.state.area.actors.find((a) => a.id === d.state.player.actorId)!.pos;
    const s = (x: number, y: number) => d.renderer.tileToScreen({ x, y });
    return {
      player: p,
      at: s(p.x, p.y),
      around: [s(p.x - r, p.y), s(p.x + r, p.y), s(p.x, p.y - r), s(p.x, p.y + r)],
      insets: d.renderer.viewportInsets,
      w: innerWidth,
      h: innerHeight,
    };
  }, r);
}

test.describe.configure({ mode: 'serial' });

test.describe('draw-call budget (desktop)', () => {
  for (const quality of ['high', 'low'] as const) {
    test(`every fixture area stays under ${DRAW_CALL_BUDGET} draw calls on ${quality}`, async ({ page }) => {
      const errors = collectErrors(page);
      const rows: string[] = [];
      for (const world of FIXTURES) {
        for (let area = 0; area < areaCount(world); area++) {
          await open(page, `world=${world}&area=${area}&seed=3&quality=${quality}`);
          const s = await page.evaluate(() => {
            const r = window.__dev!.renderer;
            r.renderNow();
            return r.stats();
          });
          rows.push(`${world}#${area}: ${s.drawCalls} calls, ${s.triangles} tris`);
          expect(s.tier).toBe(quality);
          expect(s.drawCalls, `${world} area ${area}`).toBeGreaterThan(10);
          expect(s.drawCalls, `${world} area ${area}`).toBeLessThan(DRAW_CALL_BUDGET);
        }
      }
      console.log(`[${quality}]\n${rows.join('\n')}`);
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }

  test('setQuality switches pixel ratio, shadows and lights at runtime', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'world=fixture-western&area=0&seed=3&quality=high');
    const res = await page.evaluate(() => {
      const r = window.__dev!.renderer;
      const snap = () => {
        r.renderNow();
        return { tier: r.quality.tier, shadows: r.gl.shadowMap.enabled, lamps: r.lights.lamps.filter((l) => l.visible).length, pr: r.gl.getPixelRatio(), calls: r.stats().drawCalls };
      };
      const high = snap();
      r.setQuality('low');
      const low = snap();
      r.setQuality('auto');
      const auto = snap();
      return { high, low, auto, mobile: r.quality.mobile };
    });
    expect(res.high.shadows).toBe(true);
    expect(res.low.shadows).toBe(false);
    expect(res.low.lamps).toBeLessThan(res.high.lamps);
    expect(res.low.pr).toBeLessThanOrEqual(1.5);
    // the sun's shadow pass is gone on low
    expect(res.low.calls).toBeLessThan(res.high.calls);
    // desktop Chromium without touch: auto starts high
    expect(res.mobile).toBe(false);
    expect(res.auto.tier).toBe('high');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('WebGL context loss and restore rebuild the scene in place', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'world=fixture-teen&area=0&seed=3');
    const before = await page.evaluate(() => {
      const r = window.__dev!.renderer;
      r.rotateCamera(1);
      r.zoomBy(1.3);
      r.skipAnimations();
      r.rig.settle();
      r.renderNow();
      const changes: boolean[] = [];
      r.onContextChange = (lost) => changes.push(lost);
      (window as unknown as { __changes: boolean[] }).__changes = changes;
      return { calls: r.stats().drawCalls, step: r.cameraStep, dist: r.rig.distTarget };
    });
    await page.evaluate(() => window.__dev!.renderer.gl.forceContextLoss());
    await page.waitForFunction(() => window.__dev!.renderer.stats().contextLost === true);
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__dev!.renderer.gl.forceContextRestore());
    await page.waitForFunction(() => window.__dev!.renderer.stats().contextLost === false);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => {
      const r = window.__dev!.renderer;
      r.skipAnimations();
      r.renderNow();
      const d = window.__dev!;
      const p = d.state.area.actors.find((a) => a.id === d.state.player.actorId)!.pos;
      const sp = r.tileToScreen(p);
      // the floor next to the player and the sky far up must not be the same flat colour (a black / empty canvas)
      const px = r.samplePixels([
        [sp.x, sp.y],
        [sp.x + 30, sp.y + 10],
        [innerWidth / 2, 4],
      ]);
      return { calls: r.stats().drawCalls, step: r.cameraStep, dist: r.rig.distTarget, px, changes: (window as unknown as { __changes: boolean[] }).__changes, gl: !r.gl.getContext().isContextLost() };
    });
    await page.screenshot({ path: `${OUT}/render-mobile-context-restored.png` });
    expect(after.gl).toBe(true);
    expect(after.changes).toEqual([true, false]);
    expect(after.step).toBe(before.step);
    expect(after.dist).toBeCloseTo(before.dist, 3);
    expect(after.calls).toBeGreaterThan(before.calls * 0.7);
    expect(new Set(after.px).size).toBeGreaterThan(1);
    expect(after.px.some((c) => c !== '#000000')).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

const DEVICES = [
  { name: 'iphone-portrait', dev: IPHONE, insets: [56, 0, 132, 0] },
  { name: 'iphone-landscape', dev: { ...IPHONE, viewport: { width: 844, height: 390 } }, insets: [44, 0, 76, 0] },
  { name: 'pixel-portrait', dev: PIXEL, insets: [56, 0, 132, 0] },
  { name: 'pixel-landscape', dev: { ...PIXEL, viewport: { width: 915, height: 412 } }, insets: [44, 0, 76, 0] },
] as const;

for (const d of DEVICES) {
  test.describe(`phone: ${d.name}`, () => {
    test.use(d.dev);

    test(`auto quality is low, player framed inside the HUD-free area (${d.name})`, async ({ page }) => {
      const errors = collectErrors(page);
      const worlds = d.name === 'iphone-portrait' ? FIXTURES : ['fixture-western', 'fixture-dream'];
      for (const world of worlds) {
        await open(page, `world=${world}&area=0&seed=3&insets=${d.insets.join(',')}`);
        const s = await page.evaluate(() => {
          const r = window.__dev!.renderer;
          r.renderNow();
          return { ...r.stats(), mobile: r.quality.mobile, dpr: devicePixelRatio };
        });
        expect(s.mobile).toBe(true);
        expect(s.tier).toBe('low');
        expect(s.pixelRatio).toBeLessThanOrEqual(1.5);
        expect(s.dpr).toBeGreaterThan(2);
        expect(s.drawCalls).toBeLessThan(DRAW_CALL_BUDGET);

        const f = await framing(page, 3);
        const [top, right, bottom, left] = d.insets;
        // the player is in the middle of the free rectangle (not under the HUD or hotbar)
        const cx = (left + (f.w - right)) / 2;
        const cy = (top + (f.h - bottom)) / 2;
        expect(Math.abs(f.at.x - cx)).toBeLessThan(f.w * 0.06);
        expect(Math.abs(f.at.y - cy)).toBeLessThan(f.h * 0.12);
        // three tiles in every direction stay in the free rectangle
        for (const p of f.around) {
          expect(p.x).toBeGreaterThan(left);
          expect(p.x).toBeLessThan(f.w - right);
          expect(p.y).toBeGreaterThan(top);
          expect(p.y).toBeLessThan(f.h - bottom);
        }
        // at the default zoom (auto framing may zoom further out to keep visible actors on screen),
        // tiles stay big enough to tap (≥ 36 CSS px between neighbouring tile centres)
        const a = await page.evaluate(({ x, y }) => {
          const r = window.__dev!.renderer;
          const keep = r.rig.frameDist;
          r.rig.setFrameDist(0);
          r.rig.settle();
          setTimeout(() => r.rig.setFrameDist(keep));
          const p0 = r.tileToScreen({ x, y });
          const p1 = r.tileToScreen({ x: x + 1, y });
          return Math.hypot(p1.x - p0.x, p1.y - p0.y);
        }, f.player);
        expect(a).toBeGreaterThan(36);
        await page.screenshot({ path: `${OUT}/render-mobile-${d.name}-${world.replace('fixture-', '')}.png` });
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}

test.describe('touch camera (iPhone)', () => {
  test.use(IPHONE);

  /** two-finger gesture on the view with synthetic touch pointer events */
  async function gesture(page: Page, from: [[number, number], [number, number]], to: [[number, number], [number, number]], steps = 8) {
    await page.evaluate(
      ({ from, to, steps }) => {
        const el = document.getElementById('view')!;
        const fire = (type: string, id: number, x: number, y: number) =>
          el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: id === 1 }));
        fire('pointerdown', 1, from[0][0], from[0][1]);
        fire('pointerdown', 2, from[1][0], from[1][1]);
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          for (const id of [1, 2]) {
            const a = from[id - 1];
            const b = to[id - 1];
            fire('pointermove', id, a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k);
          }
        }
        fire('pointerup', 2, to[1][0], to[1][1]);
        fire('pointerup', 1, to[0][0], to[0][1]);
      },
      { from, to, steps },
    );
  }

  test('pinch zooms, twist rotates in 90° steps, tap picks tiles and actors', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, 'world=fixture-western&area=0&seed=3');
    const dist0 = await page.evaluate(() => window.__dev!.renderer.rig.distTarget);
    // spread fingers: zoom in (camera closer)
    await gesture(page, [[150, 400], [240, 400]], [[100, 400], [290, 400]]);
    const dist1 = await page.evaluate(() => window.__dev!.renderer.rig.distTarget);
    expect(dist1).toBeLessThan(dist0 * 0.7);
    // pinch together: zoom out again
    await gesture(page, [[100, 400], [290, 400]], [[160, 400], [230, 400]]);
    const dist2 = await page.evaluate(() => window.__dev!.renderer.rig.distTarget);
    expect(dist2).toBeGreaterThan(dist1 * 1.5);

    // twist clockwise by ~60° around the centre: exactly one step, world turns clockwise (-1)
    const step0 = await page.evaluate(() => window.__dev!.renderer.cameraStep);
    const c = [195, 420];
    const rot = (deg: number, r: number): [number, number] => [c[0] + Math.cos((deg * Math.PI) / 180) * r, c[1] + Math.sin((deg * Math.PI) / 180) * r];
    await gesture(page, [rot(180, 80), rot(0, 80)], [rot(240, 80), rot(60, 80)], 12);
    const step1 = await page.evaluate(() => window.__dev!.renderer.cameraStep);
    expect(step1).toBe((step0 + 3) % 4);
    await page.evaluate(() => {
      window.__dev!.renderer.skipAnimations();
      window.__dev!.renderer.rig.settle();
    });

    // pick: the player's tile centre, and an actor's head (which covers tiles behind it)
    const picks = await page.evaluate(() => {
      const d = window.__dev!;
      const r = d.renderer;
      r.renderNow();
      const p = d.state.area.actors.find((a) => a.id === d.state.player.actorId)!;
      const sp = r.tileToScreen(p.pos);
      const onPlayer = r.pick(sp.x, sp.y);
      const other = d.state.area.actors.find((a) => a.id !== p.id && d.state.area.seen[a.pos.y * d.state.area.map.width + a.pos.x] === 2);
      let onHead: unknown = null;
      let head = null;
      if (other) {
        // high up the model: a tall actor covers the tiles behind it on screen
        head = r.actorScreen(other.id, 0.8);
        if (head) onHead = r.pick(head.x, head.y);
      }
      return { player: p.pos, onPlayer, other: other?.pos ?? null, onHead, ground: other && head ? r.screenToTile(head.x, head.y) : null };
    });
    expect(picks.onPlayer).toEqual(picks.player);
    expect(picks.other).not.toBeNull();
    if (picks.other) {
      expect(picks.onHead).toEqual(picks.other);
      // plain ground picking would have given the tile behind
      expect(picks.ground).not.toEqual(picks.other);
    }

    // a real tap highlights the tapped tile (dev page wiring: click → pick → highlight)
    const sp = await page.evaluate(() => {
      const d = window.__dev!;
      const p = d.state.area.actors.find((a) => a.id === d.state.player.actorId)!.pos;
      return d.renderer.tileToScreen({ x: p.x + 1, y: p.y });
    });
    await page.touchscreen.tap(sp.x, sp.y);
    const hl = await page.evaluate(() => !!window.__dev!.renderer.scene.getObjectByName('highlight'));
    expect(hl).toBe(true);
    await page.screenshot({ path: `${OUT}/render-mobile-touch-rotated.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
