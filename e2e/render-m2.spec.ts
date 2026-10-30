/**
 * M2 renderer checks: backdrops, non-realistic layouts, abstract patterns, framing, wall coverage,
 * liquids and reduce-motion. Screenshots go to docs/progress/M2/render-*.png for review.
 * Run: xvfb-run -a npx playwright test e2e/render-m2.spec.ts
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });

const worlds = readdirSync(join(process.cwd(), 'content/worlds'))
  .filter((f) => f.startsWith('fixture-') && f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
// fixture-dream is written by the content team; the dev page falls back to a synthetic dream world
const DREAM = 'fixture-dream';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(400);
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

test.describe.configure({ mode: 'serial' });

const BACKDROPS: { style: string; bd: string; bd2: string }[] = [
  { style: 'color', bd: '1d2440', bd2: '3b4a7a' },
  { style: 'gradient', bd: 'ff9ecf', bd2: '2a1b5e' },
  { style: 'starfield', bd: '060816', bd2: 'a98bff' },
  { style: 'clouds', bd: 'bcd7f5', bd2: '6f8fc0' },
  { style: 'abyss', bd: '2a1430', bd2: 'ff9a8a' },
  { style: 'aurora', bd: '05101a', bd2: '4dffb0' },
  { style: 'grid', bd: '070a1a', bd2: 'ff4fd8' },
  { style: 'noise', bd: '30364a', bd2: '8b93b8' },
];

for (const b of BACKDROPS) {
  test(`backdrop ${b.style} is drawn behind the map and through the void`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/dev/area.html?world=${DREAM}&area=0&backdrop=${b.style}&bd=${b.bd}&bd2=${b.bd2}&bi=0.8&gen=islands&still=1`);
    const res = await page.evaluate(() => {
      const r = window.__dev!.renderer;
      const info = r.backdropInfo;
      // a ring of samples near the screen border: islands leave most of it void
      const pts: [number, number][] = [];
      for (let k = 0; k < 16; k++) pts.push([20 + k * 78, 790], [20 + k * 78, 110], [10, 110 + k * 42], [1270, 110 + k * 42]);
      const px = r.samplePixels(pts);
      return { info, px };
    });
    expect(res.info?.style).toBe(b.style);
    // every sample must look like the backdrop's colour family, not the default black
    const spread = (i: number) => Math.max(...res.px.map((p) => hex(p)[i])) - Math.min(...res.px.map((p) => hex(p)[i]));
    const maxSpread = Math.max(spread(0), spread(1), spread(2));
    if (b.style !== 'color') expect(maxSpread, `${b.style} should vary across the view: ${res.px.join(' ')}`).toBeGreaterThan(8);
    const nonBlack = res.px.filter((p) => Math.max(...hex(p)) > 10).length;
    expect(nonBlack, res.px.join(' ')).toBeGreaterThan(res.px.length * 0.6);
    await page.screenshot({ path: `${OUT}/render-backdrop-${b.style}.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('reduce motion freezes the backdrop', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, `/dev/area.html?world=${DREAM}&area=0&backdrop=noise&bd=30364a&bd2=d0d8ff&bi=1&gen=islands&still=1`);
  const a = await page.evaluate(() => window.__dev!.renderer.samplePixels([[30, 400], [1250, 700]]));
  await page.waitForTimeout(700);
  const b = await page.evaluate(() => window.__dev!.renderer.samplePixels([[30, 400], [1250, 700]]));
  expect(b).toEqual(a);
  expect(errors, errors.join('\n')).toEqual([]);
});

for (let area = 0; area < 4; area++) {
  test(`dream world area ${area} renders (non-realistic layouts)`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/dev/area.html?world=${DREAM}&area=${area}&seed=3`);
    const stats = await page.evaluate(() => {
      const r = window.__dev!.renderer as unknown as { area: { stats(): Record<string, number>; wallStyle: string; plan: { generator: string } } };
      return { stats: r.area.stats(), style: r.area.wallStyle, gen: r.area.plan.generator };
    });
    if (stats.gen === 'organic') expect(stats.style).toBe('blob');
    if (stats.gen === 'geometric') expect(stats.style).toBe('crisp');
    // void layouts get platform undersides
    if (stats.gen === 'islands') expect(stats.stats.underside ?? 0).toBeGreaterThan(10);
    await page.screenshot({ path: `${OUT}/render-dream-${area}.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

for (const gen of ['islands', 'organic', 'geometric']) {
  for (const pattern of gen === 'geometric' ? ['grid', 'lines', 'gradient', 'noise', 'none'] : ['gradient']) {
    test(`dev ${gen} layout with ${pattern} floors`, async ({ page }) => {
      const errors = collectErrors(page);
      await open(page, `/dev/area.html?world=synthetic-dream&area=${gen === 'islands' ? 0 : gen === 'organic' ? 1 : 2}&fp=${pattern}&seed=5`);
      await page.screenshot({ path: `${OUT}/render-dev-${gen}-${pattern}.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }
}

for (const world of worlds.filter((w) => w !== DREAM)) {
  test(`default framing and wall coverage in ${world}`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/dev/area.html?world=${world}&area=0&seed=3`);
    const res = await page.evaluate(() => {
      const d = window.__dev!;
      const r = d.renderer;
      r.rig.settle();
      r.renderNow();
      const p = d.state.area.actors.find((a) => a.id === d.state.players[d.state.party[0]].actorId)!.pos;
      const W = innerWidth;
      const H = innerHeight;
      const on = (q: { x: number; y: number }) => {
        const s = r.tileToScreen(q);
        return s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H;
      };
      return {
        sides: on({ x: p.x - 8, y: p.y }) && on({ x: p.x + 8, y: p.y }),
        ahead: on({ x: p.x, y: p.y - 7 }),
        tooFar: on({ x: p.x - 13, y: p.y }) && on({ x: p.x + 13, y: p.y }),
        walls: r.coverage(),
      };
    });
    expect(res.sides, 'about 8 tiles visible to each side').toBe(true);
    expect(res.tooFar, 'not zoomed out so far that 13 tiles fit on each side').toBe(false);
    expect(res.ahead, '7 rows ahead visible').toBe(true);
    expect(res.walls, `walls cover ${(res.walls * 100).toFixed(1)}% of the view`).toBeLessThan(0.35);
    await page.screenshot({ path: `${OUT}/render-framing-${world}.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('walls next to the player in the ship never dominate the frame (fixture-ship, all areas)', async ({ page }) => {
  const errors = collectErrors(page);
  for (let area = 0; area < 3; area++) {
    await open(page, `/dev/area.html?world=fixture-ship&area=${area}&seed=7`);
    // walk along a corridor-ish spot: pick the floor tile with the most walls around it near the start
    const cov = await page.evaluate(async () => {
      const d = window.__dev!;
      const next = structuredClone(d.state);
      const m = next.area.map;
      const W = m.width;
      const p = next.area.actors.find((a) => a.id === next.players[next.party[0]].actorId)!;
      let best = p.pos;
      let bestN = -1;
      for (let y = 1; y < m.height - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          if (m.tiles[y * W + x].kind !== 'floor') continue;
          let n = 0;
          for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) if (m.tiles[(y + oy) * W + x + ox]?.kind === 'wall') n++;
          if (n > bestN && n < 15) {
            bestN = n;
            best = { x, y };
          }
        }
      p.pos = best;
      const seen = new Uint8Array(m.tiles.length).fill(1);
      for (let y = 0; y < m.height; y++) for (let x = 0; x < W; x++) if (Math.max(Math.abs(x - best.x), Math.abs(y - best.y)) <= 7) seen[y * W + x] = 2;
      next.players[next.party[0]].seen = seen;
      d.state = next;
      await d.renderer.sync(next, []);
      d.renderer.skipAnimations();
      d.renderer.rig.settle();
      await new Promise((r) => setTimeout(r, 600)); // height profile eases in
      // share of the view whose ground is wall tiles anyway (a maze is half walls seen from straight above)
      let wallGround = 0;
      let n = 0;
      for (let y = 10; y < innerHeight; y += 20)
        for (let x = 10; x < innerWidth; x += 20) {
          const t = d.renderer.screenToTile(x, y);
          n++;
          if (t && m.tiles[t.y * W + t.x].kind === 'wall') wallGround++;
        }
      return { cov: d.renderer.coverage(), ground: wallGround / n };
    });
    await page.screenshot({ path: `${OUT}/render-ship-walls-${area}.png` });
    // rooms: walls stay under 35 % of the view; a maze (area 1) is mostly wall tiles from any angle,
    // so there the wall faces may add at most a quarter of the view beyond the walls' own footprint
    const limit = area === 1 ? cov.ground + 0.25 : 0.35;
    expect(cov.cov, `ship area ${area}: walls cover ${(cov.cov * 100).toFixed(1)}% (ground ${(cov.ground * 100).toFixed(1)}%)`).toBeLessThan(limit);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('flat liquids are soft translucent surfaces, not flat UI-like quads (fixture-teen)', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, `/dev/area.html?world=fixture-teen&area=0&seed=3`);
  const res = await page.evaluate(async () => {
    const d = window.__dev!;
    const next = structuredClone(d.state);
    const m = next.area.map;
    const W = m.width;
    // a 3×2 seep in open floor right next to the player
    const p = next.area.actors.find((a) => a.id === next.players[next.party[0]].actorId)!;
    let placed = 0;
    for (let y = p.pos.y - 3; y <= p.pos.y + 3 && placed < 6; y++)
      for (let x = p.pos.x + 1; x <= p.pos.x + 4 && placed < 6; x++) {
        const t = m.tiles[y * W + x];
        if (t && t.kind === 'floor') {
          t.terrain = 'seep-water';
          placed++;
        }
      }
    const seen = new Uint8Array(m.tiles.length).fill(2);
    next.players[next.party[0]].seen = seen;
    d.state = next;
    await d.renderer.sync(next, []);
    d.renderer.skipAnimations();
    d.renderer.zoom(-6);
    d.renderer.rig.settle();
    const r = d.renderer as unknown as { area: { group: { getObjectByName(n: string): { type: string; material: { transparent: boolean; opacity: number; vertexColors: boolean; roughness: number } } | undefined } } };
    const layer = r.area.group.getObjectByName('terrain:seep-water');
    return layer ? { type: layer.type, transparent: layer.material.transparent, opacity: layer.material.opacity, vc: layer.material.vertexColors, rough: layer.material.roughness, placed } : null;
  });
  expect(res).not.toBeNull();
  expect(res!.type).toBe('Mesh');
  expect(res!.transparent).toBe(true);
  expect(res!.opacity).toBeLessThan(0.9);
  expect(res!.vc).toBe(true);
  // matte like a 'water' floor: a shiny normal-mapped surface glinted as spiky stars (issues/M2-liquid-terrain-stars.md)
  expect(res!.rough).toBeGreaterThanOrEqual(0.4);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/render-liquid-fixture-teen.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('cut-away walls are low stubs with a visible cap (fixture-western)', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, `/dev/area.html?world=fixture-western&area=0&seed=3`);
  const res = await page.evaluate(async () => {
    const d = window.__dev!;
    const r = d.renderer as unknown as { area: { loweredTiles: ReadonlySet<number>; inspect(i: number): { wallScale: number }; wallHeight: number } };
    const set = [...r.area.loweredTiles];
    return set.map((i) => r.area.inspect(i).wallScale * r.area.wallHeight);
  });
  for (const h of res) expect(h).toBeGreaterThan(0.2);
  await page.screenshot({ path: `${OUT}/render-cutaway-fixture-western.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});
