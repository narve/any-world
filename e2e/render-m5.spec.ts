/**
 * M5 renderer fixes in the browser:
 *  - item thumbnails (issues/M5-item-thumbnails.md): the game's renderer draws each known item's model
 *    into a small image; hotbar and backpack show it instead of a lone letter.
 *  - framing around overlay panels (issues/M5-actors-under-overlays.md): Renderer.setOverlayRects makes
 *    auto framing shift the view (or zoom out) until no visible actor stands under a panel
 *    (issues/M5-phone-hostiles-under-panels.md).
 * Screenshots go to test-results/shots/M5-render/.
 * Run: xvfb-run -a npx playwright test -c tests/render/playwright.render.config.ts e2e/render-m5.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'test-results/shots/M5-render';
mkdirSync(OUT, { recursive: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/api\/|502|Bad Gateway|Failed to load resource/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** English UI, clean storage, and no Vite HMR socket (other agents' edits must not reload the page) */
async function prepare(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', 'en');
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
  });
}

async function startWorld(page: Page, id: string) {
  await prepare(page);
  await page.goto(`/?world=${id}`);
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(500);
}

test.describe.configure({ mode: 'serial' });

test('hotbar and backpack show rendered item thumbnails for known items', async ({ page }) => {
  const errors = collectErrors(page);
  await startWorld(page, 'viking-lawspeaker-althing');
  const api = await page.evaluate(() => typeof window.__anyworld!.renderer!.itemThumbnail);
  expect(api).toBe('function');

  // the renderer answers known def ids with a PNG and unknown ones with null
  const direct = await page.evaluate(() => {
    const a = window.__anyworld!;
    const world = a.controller!.session.world;
    const r = a.renderer!;
    const urls = world.items.filter((i) => i.model).map((i) => r.itemThumbnail(i.id));
    return { urls: urls.length, png: urls.filter((u) => typeof u === 'string' && u.startsWith('data:image/png')).length, missing: r.itemThumbnail('no-such-item'), distinct: new Set(urls).size };
  });
  expect(direct.png).toBe(direct.urls);
  expect(direct.distinct).toBe(direct.urls);
  expect(direct.missing).toBeNull();

  await page.evaluate(() => window.__anyworld!.ui.setBackpackOpen(true));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/viking-backpack-thumbs.png` });
  const slots = page.locator('.aw-backpack');
  if (await slots.count()) await slots.first().screenshot({ path: `${OUT}/viking-backpack-thumbs-close.png` });

  const shown = await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.aw-glyph.has-thumb img'));
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => i.addEventListener('load', r, { once: true })))));
    // the pictures are not empty: a good share of their pixels are opaque, and not all one colour
    const stats = imgs.slice(0, 6).map((img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      const colours = new Set<number>();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3]! > 200) {
          opaque++;
          colours.add(((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4));
        }
      }
      return { w: img.naturalWidth, opaque: opaque / (c.width * c.height), colours: colours.size };
    });
    const unknownWithImg = document.querySelectorAll('.aw-glyph.is-unknown img').length;
    return { count: imgs.length, distinct: new Set(imgs.map((i) => i.src)).size, stats, unknownWithImg };
  });
  console.log(JSON.stringify(shown));
  expect(shown.count).toBeGreaterThan(2);
  expect(shown.distinct).toBeGreaterThan(1);
  expect(shown.unknownWithImg).toBe(0);
  for (const s of shown.stats) {
    expect(s.w).toBe(64);
    // thin things (a staff) cover little of the square; nothing is empty
    expect(s.opaque).toBeGreaterThan(0.02);
    expect(s.colours).toBeGreaterThan(3);
  }
  expect(shown.stats.reduce((a, s) => a + s.opaque, 0) / shown.stats.length).toBeGreaterThan(0.06);
  // the main view still renders normally after the offscreen passes
  const px = await page.evaluate(() => {
    const r = window.__anyworld!.renderer!;
    r.renderNow();
    return r.stats();
  });
  expect(px.drawCalls).toBeGreaterThan(10);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('overlay rects keep visible actors from standing under the panels', async ({ page }) => {
  const errors = collectErrors(page);
  await prepare(page);
  await page.goto('/dev/area.html?world=fixture-western&area=0&seed=3&quality=low');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  const res = await page.evaluate(() => {
    const d = window.__dev!;
    const r = d.renderer;
    r.skipAnimations();
    r.rig.settle();
    r.renderNow();
    const area = d.state.area;
    const W = area.map.width;
    const seen = d.state.players[d.state.party[0]].seen as ArrayLike<number>;
    const visible = area.actors.filter((a) => a.id !== d.state.players[d.state.party[0]].actorId && seen[a.pos.y * W + a.pos.x] === 2);
    if (!visible.length) return null;
    // the actor farthest from the view centre gets a pretend panel right over it
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const far = visible
      .map((a) => ({ a, s: r.tileToScreen(a.pos) }))
      .sort((p, q) => Math.hypot(q.s.x - cx, q.s.y - cy) - Math.hypot(p.s.x - cx, p.s.y - cy))[0]!;
    const before = far.s;
    const rect = { left: before.x - 60, top: before.y - 60, right: before.x + 60, bottom: before.y + 60 };
    const distBefore = r.rig.distTarget;
    r.setOverlayRects([rect]);
    r.rig.settle();
    r.renderNow();
    const after = r.tileToScreen(far.a.pos);
    const head = r.actorScreen(far.a.id, 1);
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: '120px', height: '120px', background: 'rgba(0,0,0,0.5)', outline: '1px dashed #fff', pointerEvents: 'none' });
    document.body.appendChild(box);
    return { before, after, head, rect, distBefore, distAfter: r.rig.distTarget, pan: { ...r.rig.panTarget }, inUse: r.overlayRectsInUse.length };
  });
  expect(res, 'fixture-western area 0 has a visible actor').not.toBeNull();
  await page.screenshot({ path: `${OUT}/overlay-framing.png` });
  const inside = (p: { x: number; y: number } | null) => !!p && p.x >= res!.rect.left && p.x <= res!.rect.right && p.y >= res!.rect.top && p.y <= res!.rect.bottom;
  expect(res!.inUse).toBe(1);
  // the view shifts (preferred) or zooms out; it never zooms in
  expect(res!.distAfter).toBeGreaterThanOrEqual(res!.distBefore - 1e-6);
  expect(res!.distAfter > res!.distBefore + 1e-6 || res!.pan.x !== 0 || res!.pan.y !== 0).toBe(true);
  expect(inside(res!.after)).toBe(false);
  expect(inside(res!.head)).toBe(false);
  // clearing the rects lets the next turn frame as before
  const cleared = await page.evaluate(() => {
    const r = window.__dev!.renderer;
    r.setOverlayRects([]);
    return r.overlayRectsInUse.length;
  });
  expect(cleared).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the dev page draws pretend panels from &overlays= and frames around them', async ({ page }) => {
  const errors = collectErrors(page);
  await prepare(page);
  await page.goto('/dev/area.html?world=fixture-western&area=0&seed=3&quality=low&overlays=12,12,322,228;380,700,902,788');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  const n = await page.evaluate(() => ({ boxes: document.querySelectorAll('.overlay').length, rects: window.__dev!.renderer.overlayRectsInUse.length }));
  expect(n).toEqual({ boxes: 2, rects: 2 });
  expect(errors, errors.join('\n')).toEqual([]);
});
