/**
 * Regression checks for the M2 playtest round-1 renderer issues:
 *  - liquid terrain (teen seeps / floods) is a flat water surface, not spiky blue stars
 *  - remembered maze walls (ship Ductworks) keep a dark body and a clear top-edge outline
 * Screenshots go to docs/archive/progress/M2/fix-*.png for review.
 * Run: xvfb-run -a npx playwright test e2e/render-fixes-m2.spec.ts
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    // the HMR socket is cut on purpose (see open)
    if (m.type() === 'error' && !/\[vite\]|Vite server/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function open(page: Page, url: string) {
  // other agents edit sources while this runs: cut vite's HMR socket so no full reload wipes the page
  await page.routeWebSocket(/.*/, (ws) => ws.close());
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(400);
}

/** walk the player around (deterministic) so part of the map becomes remembered, not visible */
async function wander(page: Page, steps: number) {
  await page.evaluate(async (steps) => {
    const dev = window.__dev!;
    const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let d = 0;
    for (let i = 0; i < steps; i++) {
      const s = dev.state;
      const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
      const before = `${p.pos.x},${p.pos.y}`;
      dev.renderer.skipAnimations();
      await dev.move(dirs[d][0], dirs[d][1]);
      const s2 = window.__dev!.state;
      const p2 = s2.area.actors.find((a) => a.id === s2.players[s2.party[0]].actorId)!;
      // blocked: turn; also turn now and then to wander through the maze
      if (`${p2.pos.x},${p2.pos.y}` === before || i % 7 === 6) d = (d + 1) % 4;
    }
    dev.renderer.skipAnimations();
  }, steps);
  await page.waitForTimeout(500);
}

test.describe.configure({ mode: 'serial' });

test('remembered maze walls keep a readable outline and body (ship Ductworks)', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, '/dev/area.html?world=fixture-ship&area=1&seed=3&still=1');
  await wander(page, 60);
  await page.screenshot({ path: `${OUT}/fix-ship-ductworks-remembered.png` });
  const res = await page.evaluate(() => window.__dev!.renderer.rememberedWallContrast());
  expect(res, JSON.stringify(res)).not.toBeNull();
  // outline (edge bar) of a remembered wall stands out from its cap, and the cap from the remembered floor
  expect(res!.edgeVsCap, JSON.stringify(res)).toBeGreaterThan(0.08);
  expect(res!.capVsFloor, JSON.stringify(res)).toBeGreaterThan(0.05);
  expect(errors, errors.join('\n')).toEqual([]);
});

for (const area of [0, 1]) {
  test(`teen liquid terrain is a flat water surface (area ${area})`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/dev/area.html?world=fixture-teen&area=${area}&seed=1&still=1`);
    await wander(page, 12);
    // what the 'The Water's Coming' rule does on arrival: a radius-2 seep around the player
    await page.evaluate(async () => {
      const dev = window.__dev!;
      const s = structuredClone(dev.state);
      const p = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
      const W = s.area.map.width;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 5) continue;
          const t = s.area.map.tiles[(p.pos.y + dy) * W + p.pos.x + dx];
          if (t && t.kind === 'floor') t.terrain = 'seep-water';
        }
      dev.state = s;
      await dev.renderer.sync(s, []);
      dev.renderer.skipAnimations();
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/fix-teen-liquid-area${area}.png` });
    const liquid = await page.evaluate(() => window.__dev!.renderer.liquidTerrainInfo());
    expect(liquid.length).toBeGreaterThan(0);
    for (const l of liquid) {
      expect(l.roughness, JSON.stringify(l)).toBeGreaterThanOrEqual(0.4);
      expect(l.normalMap, JSON.stringify(l)).toBe(false);
      expect(l.folded, JSON.stringify(l)).toBe(0);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
