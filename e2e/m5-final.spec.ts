/**
 * M5 final gate screenshots (DESIGN §10 items 5, 11, 12): several recorded worlds are started in demo
 * mode on desktop, on a phone in portrait and in Norwegian bokmål, played a few dozen turns by the
 * sim's explorer bot through the real controller, and captured mid-run (cards dismissed).
 * Checks along the way: no page errors, the game layer is shown, no horizontal scroll on the phone,
 * and in a bokmål session the visible game text carries no stock English engine lines.
 * Committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1.
 * Run: SHOTS_TO_DOCS=1 xvfb-run -a npx playwright test e2e/m5-final.spec.ts
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M5' : 'test-results/shots/M5-final';
mkdirSync(OUT, { recursive: true });
const ROOT = resolve('.');

type Device = (typeof devices)[string];
function phone(name: string): Omit<Device, 'defaultBrowserType'> {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

interface Case {
  world: string;
  lang: 'en' | 'nb';
  steps: number;
}

const DESKTOP: Case[] = [
  { world: 'heist-silent-vault', lang: 'en', steps: 30 },
  { world: 'deep-sea-whale-fall', lang: 'en', steps: 30 },
  { world: 'viking-lawspeaker-althing', lang: 'en', steps: 30 },
  { world: 'microscopic-root-nodule', lang: 'en', steps: 30 },
  { world: 'cyberpunk-rooftop-yams', lang: 'en', steps: 30 },
];
const MOBILE: Case[] = [
  { world: 'fixture-western', lang: 'en', steps: 25 },
  { world: 'alien-twilight-migration', lang: 'en', steps: 25 },
  { world: 'folk-horror-scarecrow-wedding', lang: 'en', steps: 25 },
  { world: 'nb-troll-direktoratet', lang: 'nb', steps: 25 },
];
const NB: Case[] = [
  { world: 'nb-nordisk-noir-tromso', lang: 'nb', steps: 30 },
  { world: 'nb-russetid-bussen', lang: 'nb', steps: 30 },
  { world: 'viking-lawspeaker-althing-nb', lang: 'nb', steps: 30 },
  { world: 'corporate-merger-kitchen-nb', lang: 'nb', steps: 30 },
];

/** stock English engine lines that must not appear in a bokmål session */
const ENGLISH_LINES = [/\bYou (hit|miss|pick up|wait)\b/, /\bnot in reach\b/i, /\bLevel up\b/, /\bBackpack\b/, /\bInventory\b/];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/favicon|Failed to load resource|\/api\/|502|Bad Gateway/.test(m.text())) return;
    errors.push(m.text());
  });
  return errors;
}

async function prepare(page: Page, lang: string): Promise<void> {
  await page.addInitScript((l) => {
    try {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', l);
    } catch {
      /* storage blocked */
    }
    // no Vite HMR socket: edits elsewhere in the tree must not reload the page mid-run
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, lang);
}

async function start(page: Page, c: Case): Promise<void> {
  await prepare(page, c.lang);
  await page.goto(`/?world=${c.world}`);
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  expect(await page.evaluate(() => window.__anyworld!.controller!.session.worldId)).toBe(c.world);
}

/** dismisses narration / onboarding cards and modal choices that would hide the map */
async function clearCards(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const narr = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (await narr.isVisible().catch(() => false)) {
      await narr.first().click();
      await page.waitForTimeout(200);
      continue;
    }
    const ok = page.locator('.aw-onboard:not([hidden]) .aw-onboard-ok');
    if (await ok.isVisible().catch(() => false)) {
      await ok.first().click();
      await page.waitForTimeout(200);
      continue;
    }
    break;
  }
}

/** the explorer bot plays `steps` turns through the real controller (stops early on a run end) */
async function play(page: Page, steps: number): Promise<{ status: string; turn: number; area: number }> {
  const botPath = '/@fs' + join(ROOT, 'src/engine/sim/bots.ts');
  return page.evaluate(
    async ([botPath, steps]) => {
      const mod = (await import(/* @vite-ignore */ botPath as string)) as typeof import('../src/engine/sim/bots');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = window.__anyworld!.controller as any;
      const bot = mod.botByName('explorer');
      const mem = mod.newMemory(11);
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < (steps as number) && c.session.state.status === 'playing'; i++) {
        c.actNow(bot.decide(c.session.state, c.session.world, mem));
        await sleep(30);
      }
      await sleep(900);
      return { status: c.session.state.status as string, turn: c.session.state.turn as number, area: c.session.state.area.index as number };
    },
    [botPath, steps] as const,
  );
}

async function shoot(page: Page, c: Case, tag: string, errors: string[]): Promise<void> {
  await start(page, c);
  await clearCards(page);
  const r = await play(page, c.steps);
  await clearCards(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/final-${tag}-${c.world}.png` });
  console.log(`${tag} ${c.world}: ${r.status} turn ${r.turn} area ${r.area}`);
  const layer = await page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');
  // the run is on screen (a card the GM or a level-up raised meanwhile is fine), not stuck loading
  expect(['none', 'start', 'loading']).not.toContain(layer);
  if (c.lang === 'nb') {
    const text = await page.evaluate(() => (document.querySelector('.aw-game') as HTMLElement | null)?.innerText ?? '');
    for (const re of ENGLISH_LINES) expect(text, `${c.world}: English line ${re}`).not.toMatch(re);
  }
  expect(errors, errors.join('\n')).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.describe('desktop', () => {
  for (const c of DESKTOP) {
    test(`desktop ${c.world}`, async ({ page }) => {
      await shoot(page, c, 'desktop', watchErrors(page));
    });
  }
});

test.describe('nb desktop', () => {
  for (const c of NB) {
    test(`nb ${c.world}`, async ({ page }) => {
      await shoot(page, c, 'nb', watchErrors(page));
    });
  }
});

test.describe('phone portrait', () => {
  test.use(phone('iPhone 15'));
  for (const c of MOBILE) {
    test(`phone ${c.world}`, async ({ page }) => {
      const errors = watchErrors(page);
      await shoot(page, c, c.lang === 'nb' ? 'phone-nb' : 'phone', errors);
      const scroll = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: innerWidth }));
      expect(scroll.w).toBeLessThanOrEqual(scroll.vw + 1);
    });
  }
});
