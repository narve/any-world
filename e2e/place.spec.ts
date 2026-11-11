/**
 * Real places (docs/PLACE-PLAN.md, P1–P2): pick a place in "Create a new world", see its map, and
 * start a run on it. The map services are answered from the recorded fixtures (tests/fixtures/osm),
 * so the test needs no network. With no AI on the dev server, a ready-made world is put on the place.
 * Screenshots go to docs/progress/place/.
 * Run: xvfb-run -a npx playwright test e2e/place.spec.ts
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const SHOTS = 'docs/progress/place';

interface Fixture {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  elements: unknown[];
}
const fixture = (id: string): Fixture => JSON.parse(readFileSync(`tests/fixtures/osm/${id}.json`, 'utf8'));

async function prepare(page: Page, places: Record<string, Fixture>, lang = 'en') {
  await page.addInitScript((lang) => {
    try {
      if (!sessionStorage.getItem('aw-e2e-init')) {
        sessionStorage.setItem('aw-e2e-init', '1');
        localStorage.clear();
        localStorage.setItem('anyworld.byo', '1');
        localStorage.setItem('anyworld.e2e', '1');
        localStorage.setItem('anyworld.lang.v1', lang);
      }
    } catch {
      /* storage blocked */
    }
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, lang);
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('https://nominatim.openstreetmap.org/**', async (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const hit = Object.entries(places).find(([key]) => q.includes(key))?.[1];
    await route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify(hit ? [{ lat: String(hit.lat), lon: String(hit.lon), name: hit.name, display_name: hit.displayName, type: 'square' }] : []),
    });
  });
  for (const host of ['https://overpass-api.de/**', 'https://overpass.private.coffee/**', 'https://overpass.openstreetmap.fr/**']) {
    await page.route(host, async (route) => {
      const body = decodeURIComponent(route.request().postData() ?? '');
      const m = /bbox:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(body);
      const lat = (Number(m?.[1]) + Number(m?.[3])) / 2;
      const lon = (Number(m?.[2]) + Number(m?.[4])) / 2;
      const hit = Object.values(places).find((p) => Math.abs(p.lat - lat) < 0.002 && Math.abs(p.lon - lon) < 0.004);
      await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ elements: hit?.elements ?? [] }) });
    });
  }
}

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

async function toMap(page: Page) {
  for (let i = 0; i < 8 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  expect(await layer(page)).toBe('game');
}

async function pickPlace(page: Page, query: string) {
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.locator('#aw-place').fill(query);
  await page.locator('#aw-place').press('Enter');
  await expect(page.locator('.aw-place-map')).toBeVisible({ timeout: 20000 });
  // the preview is drawn once its lazy chunk (the map generator) has loaded
  await page.waitForFunction(() => (document.querySelector('.aw-place-map') as HTMLCanvasElement | null)?.width === 560, null, { timeout: 20000 });
}

async function createAndPlay(page: Page, prompt: string) {
  await page.locator('#aw-prompt').fill(prompt);
  await page.locator('.aw-start-actions .aw-btn-primary').click();
  await page.waitForFunction(() => document.getElementById('ui-root')?.dataset.screen === 'game' && !!window.__anyworld?.controller, null, { timeout: 90000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await toMap(page);
  // the first-run card
  const gotIt = page.locator('.aw-onboard-x').first();
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
}

for (const [id, query, lang, prompt] of [
  ['domkirken', 'Kristiansand domkirke', 'en', 'a folk horror wedding with scarecrows'],
  ['tangen', 'Tangen videregående skole', 'nb', 'Tangen lærlingplassen'],
  ['placa-reial', 'Plaça Reial', 'en', 'a detective in a sugar hotel'],
  ['kkg', 'Kristiansand katedralskole Gimle', 'nb', 'KKG Talen'],
] as const) {
  test(`a world on a real place: ${id}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const fx = fixture(id);
    await prepare(page, { [query.toLowerCase()]: fx }, lang);
    await pickPlace(page, query);
    await expect(page.locator('.aw-place-name')).toHaveText(fx.name);
    await expect(page.locator('.aw-place-figure figcaption')).toContainText('OpenStreetMap');
    await page.locator('.aw-place').scrollIntoViewIfNeeded();
    await page.locator('.aw-place').screenshot({ path: `${SHOTS}/${id}-picker.png` });

    await createAndPlay(page, prompt);
    const info = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session;
      const map = s.state.area.map;
      return {
        generator: s.world.areas[0]!.generator,
        patch: s.world.areas[0]!.patch,
        place: s.world.place?.name,
        names: map.regions.map((r) => r.name).filter(Boolean),
        surfaces: map.tiles.filter((t) => t.surface).length,
        size: [map.width, map.height],
      };
    });
    expect(info.generator).toBe('place');
    expect(info.place).toBe(fx.name);
    expect(info.size).toEqual([56, 40]);
    expect(info.surfaces).toBeGreaterThan(50);
    expect(info.names.length).toBeGreaterThan(1);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/${id}-start.png` });

    // the whole area revealed (dev hook), to judge the layout from above
    await page.evaluate(() => {
      const c = window.__anyworld!.controller!;
      const lead = Object.values(c.session.state.players)[0] as { seen?: number[] | Uint8Array };
      if (lead?.seen) for (let i = 0; i < lead.seen.length; i++) lead.seen[i] = 2;
    });
    await page.keyboard.press('.');
    // zoom out as far as the camera goes
    await page.mouse.move(640, 400);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${SHOTS}/${id}-revealed.png` });
    expect(errors).toEqual([]);
  });
}

test('an example place needs no map service; Kuben at district scale plays Kuben: Valget', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let asked = 0;
  await prepare(page, {}, 'nb');
  page.on('request', (r) => {
    if (/nominatim\.openstreetmap|overpass-api|overpass\./.test(new URL(r.url()).host)) asked++;
  });
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.locator('.aw-place-sample', { hasText: 'Kuben' }).click();
  await expect(page.locator('.aw-place-map')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('.aw-place-map') as HTMLCanvasElement | null)?.width === 560, null, { timeout: 20000 });
  await expect(page.locator('.aw-place-world')).toBeVisible();
  await page.locator('.aw-place').scrollIntoViewIfNeeded();
  await page.locator('.aw-place').screenshot({ path: `${SHOTS}/kuben-district-picker.png` });
  await createAndPlay(page, 'en detektiv på et sukkerhotell');
  const info = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    const map = s.state.area.map;
    const school = map.regions.filter((r) => r.name === 'Kuben videregående skole').sort((a, b) => b.size - a.size)[0];
    return {
      title: s.world.meta.title,
      generator: s.world.areas[0]!.generator,
      area: s.world.areas[0]!.name,
      areas: s.world.areas.length,
      scale: s.world.place?.patches[0]?.scale,
      attribution: s.world.place?.attribution,
      names: map.regions.map((r) => r.name).filter(Boolean),
      school: school?.size ?? 0,
      exitFromSchool: school ? Math.hypot(map.exit.x - school.centre.x, map.exit.y - school.centre.y) : 99,
      actors: s.state.area.actors.map((a) => a.defId),
    };
  });
  expect(info).toMatchObject({ generator: 'place', scale: 'district', areas: 4, attribution: '© OpenStreetMap contributors' });
  expect(info.title).toContain('Valget');
  expect(info.area).toContain('Glassgata');
  expect(info.names).toEqual(expect.arrayContaining(['Kuben videregående skole', 'Kabelgata', 'Østre Aker vei', 'Tårngata']));
  // the school, with its wings, is one room, and the way on (the stairs down) is inside it
  expect(info.school).toBeGreaterThan(80);
  expect(info.exitFromSchool).toBeLessThan(12);
  expect(info.actors).toEqual(expect.arrayContaining(['knut', 'hege', 'slushmaskinen']));
  expect(asked).toBe(0);
  await page.waitForTimeout(1200);
  await expect.poll(() => page.locator('.ov-place').count()).toBeGreaterThan(3);
  await page.screenshot({ path: `${SHOTS}/kuben-district-start.png` });
  await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    const lead = Object.values(c.session.state.players)[0] as { seen?: number[] | Uint8Array };
    if (lead?.seen) for (let i = 0; i < lead.seen.length; i++) lead.seen[i] = 2;
  });
  await page.keyboard.press('.');
  await page.mouse.move(640, 400);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}/kuben-district-revealed.png` });
  expect(errors).toEqual([]);
});

test('a district-scale place: one room per building, names over the map; Tangen plays Tangen: Lærlingplassen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await prepare(page, {}, 'nb');
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.locator('.aw-place-sample', { hasText: 'Tangen' }).click();
  await expect(page.locator('.aw-place-map')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('.aw-place-map') as HTMLCanvasElement | null)?.width === 560, null, { timeout: 20000 });
  await page.locator('.aw-place').scrollIntoViewIfNeeded();
  await page.locator('.aw-place').screenshot({ path: `${SHOTS}/tangen-district-picker.png` });
  await expect(page.locator('.aw-place-world')).toBeVisible();
  await createAndPlay(page, 'en detektiv på et sukkerhotell');
  const info = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    const map = s.state.area.map;
    const school = map.regions.find((r) => r.name === 'Tangen videregående skole');
    return { title: s.world.meta.title, exitFromSchool: school ? Math.hypot(map.exit.x - school.centre.x, map.exit.y - school.centre.y) : 99, scale: s.world.place?.patches[0]?.scale, names: map.regions.map((r) => r.name).filter(Boolean), school: school?.size ?? 0, doorsInSchool: 0 };
  });
  expect(info.scale).toBe('district');
  expect(info.title).toContain('Lærlingplassen');
  expect(info.exitFromSchool).toBeLessThan(8);
  expect(info.names).toEqual(expect.arrayContaining(['Tangen videregående skole', 'Aquarama', 'Scandic Kristiansand Bystranda', 'Bystranda', 'Østre Strandgate']));
  // the school is one room
  expect(info.school).toBeGreaterThan(30);
  await page.waitForTimeout(1200);
  await expect.poll(() => page.locator('.ov-place').count()).toBeGreaterThan(5);
  await page.screenshot({ path: `${SHOTS}/tangen-district-start.png` });
  await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    const lead = Object.values(c.session.state.players)[0] as { seen?: number[] | Uint8Array };
    if (lead?.seen) for (let i = 0; i < lead.seen.length; i++) lead.seen[i] = 2;
  });
  await page.keyboard.press('.');
  await page.mouse.move(640, 400);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}/tangen-district-revealed.png` });
  expect(errors).toEqual([]);
});

test('a place with its own story: KKG at district scale plays KKG: Talen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await prepare(page, {}, 'nb');
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.locator('.aw-place-sample', { hasText: 'KKG' }).click();
  await expect(page.locator('.aw-place-map')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('.aw-place-map') as HTMLCanvasElement | null)?.width === 560, null, { timeout: 20000 });
  await expect(page.locator('.aw-place-world')).toBeVisible();
  await page.locator('.aw-place').scrollIntoViewIfNeeded();
  await page.locator('.aw-place').screenshot({ path: `${SHOTS}/kkg-district-picker.png` });
  // whatever is written, the place's own world is the one that is played
  await createAndPlay(page, 'en detektiv på et sukkerhotell');
  const info = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    const map = s.state.area.map;
    const school = map.regions.filter((r) => r.name === 'Kristiansand katedralskole Gimle').sort((a, b) => b.size - a.size)[0];
    const exit = map.exit;
    return {
      title: s.world.meta.title,
      area: s.world.areas[0]!.name,
      areas: s.world.areas.length,
      scale: s.world.place?.patches[0]?.scale,
      names: map.regions.map((r) => r.name).filter(Boolean),
      school: school?.size ?? 0,
      exitFromSchool: school ? Math.hypot(exit.x - school.centre.x, exit.y - school.centre.y) : 99,
      actors: s.state.area.actors.map((a) => a.defId),
    };
  });
  expect(info.title).toContain('Talen');
  expect(info.area).toContain('Mellombygget');
  expect(info.areas).toBe(4);
  expect(info.scale).toBe('district');
  expect(info.names).toEqual(expect.arrayContaining(['Kristiansand katedralskole Gimle', 'Gimlehallen', 'Oddernes kirke', 'Jegersbergveien', 'Gimleveien']));
  expect(info.school).toBeGreaterThan(30);
  // the way on (the library door) is inside the school
  expect(info.exitFromSchool).toBeLessThan(12);
  // the scenario's cast is on the map
  expect(info.actors).toEqual(expect.arrayContaining(['vaktmester', 'kantinesjef', 'skriveren']));
  await page.waitForTimeout(1200);
  await expect.poll(() => page.locator('.ov-place').count()).toBeGreaterThan(3);
  await page.screenshot({ path: `${SHOTS}/kkg-district-start.png` });
  await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    const lead = Object.values(c.session.state.players)[0] as { seen?: number[] | Uint8Array };
    if (lead?.seen) for (let i = 0; i < lead.seen.length; i++) lead.seen[i] = 2;
  });
  await page.keyboard.press('.');
  await page.mouse.move(640, 400);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}/kkg-district-revealed.png` });
  expect(errors).toEqual([]);
});
