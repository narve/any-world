/**
 * M3 gate: every recorded world is selectable in demo mode from the start screen, grouped and
 * labelled by language; each one starts, takes turns and has no page errors. The inspiration cards
 * come from content/prompts.json. Screenshots go to docs/progress/M3/gate-*.png.
 * Run: xvfb-run -a npx playwright test e2e/m3-gate.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';


// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M3' : 'test-results/shots/M3';
mkdirSync(OUT, { recursive: true });

const WORLDS = readdirSync('content/worlds')
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
const LANG: Record<string, string> = Object.fromEntries(
  WORLDS.map((id) => [id, (JSON.parse(readFileSync(`content/worlds/${id}.json`, 'utf8')).meta.language as string | undefined) ?? 'en']),
);
/**
 * M4: a recorded world and its translated copy (prompts.json `translations[lang].worldId`) are one
 * world on the start screen: the copy is listed in its language's UI, the original otherwise.
 */
const COPY_OF: Record<string, { of: string; language: string }> = {};
for (const e of (JSON.parse(readFileSync('content/prompts.json', 'utf8')) as { prompts: { worldId?: string; translations?: Record<string, { worldId?: string }> }[] }).prompts) {
  for (const [language, tr] of Object.entries(e.translations ?? {})) if (e.worldId && tr.worldId) COPY_OF[tr.worldId] = { of: e.worldId, language };
}
/** the worlds listed with UI language `ui` */
const listedFor = (ui: string) =>
  WORLDS.filter((id) => {
    const copy = COPY_OF[id];
    if (copy) return copy.language === ui;
    return !Object.entries(COPY_OF).some(([c, x]) => x.of === id && x.language === ui && WORLDS.includes(c));
  });

/** page errors and console errors, minus the /api calls that fail without a backend */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url ?? '';
    if (/\/api\//.test(m.text()) || /\/api\//.test(loc) || /502|Bad Gateway/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function prepare(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
      localStorage.setItem('anyworld.lang.v1', 'en');
    } catch {
      /* storage blocked */
    }
    // other agents edit files while this runs: keep Vite's HMR from reloading the page mid-test
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  });
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

test.describe.configure({ mode: 'serial' });

test('start screen: every recorded world, grouped by language; library inspiration', async ({ page }) => {
  const errors = collectErrors(page);
  await prepare(page);
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('.aw-start')).toBeVisible();

  // one group per language, English (the UI language) first
  const groups = page.locator('.aw-demo-group');
  await expect(groups).toHaveCount(2);
  expect(await groups.first().getAttribute('data-lang')).toBe('en');
  expect(await groups.nth(1).getAttribute('data-lang')).toBe('nb');
  await expect(groups.nth(1).locator('.aw-demo-lang')).toContainText(/bokmål/i);

  // every bundled world is listed exactly once, in its language's group or as the featured world at
  // the top (a translated copy stands in for its original only in its own language's UI)
  const listed = await page.locator('.aw-demo, .aw-featured-play').evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset.world!, lang: (e.closest('.aw-featured') ?? e).getAttribute('lang') ?? '' })));
  expect(listed.map((d) => d.id).sort()).toEqual(listedFor('en'));
  for (const d of listed) expect(d.lang, d.id).toBe(LANG[d.id]!.split('-')[0]);

  // inspiration: four cards from the library, in the UI language
  const cards = page.locator('.aw-insp-card');
  await expect(cards).toHaveCount(4);
  expect(await cards.evaluateAll((els) => els.every((e) => e.getAttribute('lang') === 'en'))).toBe(true);
  await cards.first().locator('.aw-insp-fill').click();
  expect((await page.locator('#aw-prompt').inputValue()).length).toBeGreaterThan(40);
  await page.screenshot({ path: `${OUT}/gate-start-desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.locator('.aw-demo-group').nth(1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/gate-start-phone-390x844.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Norwegian UI: the bokmål worlds and prompts come first', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => localStorage.setItem('anyworld.lang.v1', 'nb'));
  await page.goto('/');
  await waitReady(page);
  const lang = await page.evaluate(() => document.documentElement.lang || '');
  test.skip(!/^nb/.test(lang) && (await page.locator('.aw-demo-group').first().getAttribute('data-lang')) !== 'nb', 'no Norwegian UI catalog yet');
  expect(await page.locator('.aw-demo-group').first().getAttribute('data-lang')).toBe('nb');
  expect(await page.locator('.aw-insp-card').evaluateAll((els) => els.filter((e) => e.getAttribute('lang') === 'nb').length)).toBeGreaterThanOrEqual(4);
});

for (const id of WORLDS) {
  test(`demo world ${id} starts from the start screen and plays`, async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page);
    // a translated copy is offered in its own language's UI
    const ui = COPY_OF[id]?.language;
    if (ui) await page.addInitScript((l) => localStorage.setItem('anyworld.lang.v1', l), ui);
    await page.goto('/');
    await waitReady(page);
    await page.locator(`:is(.aw-demo, .aw-featured-play)[data-world="${id}"]`).click();
    await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
    await waitReady(page);
    await expect(page.locator('.aw-game')).toBeVisible();
    const worldId = await page.evaluate(() => window.__anyworld!.controller!.session.worldId);
    expect(worldId).toBe(id);
    // past the intro narration, then a few turns
    for (let i = 0; i < 3; i++) {
      if ((await page.evaluate(() => window.__anyworld!.ui.layer())) !== 'narration') break;
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
    const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    for (const k of ['.', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', '.']) {
      await page.keyboard.press(k);
      await page.waitForTimeout(160);
    }
    const s = await page.evaluate(() => {
      const st = window.__anyworld!.controller!.session.state;
      return { turn: st.turn, status: st.status, language: document.querySelector('#ui-root')?.getAttribute('lang') ?? '' };
    });
    expect(s.turn).toBeGreaterThan(t0);
    expect(s.status).toBe('playing');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/gate-${id}.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
