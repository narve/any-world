/**
 * M5 DoD audit (DESIGN §10 items 2, 5, 12): every recorded world is started from the start screen in
 * demo mode (no LLM) and played to its end screen in the browser by the sim's explorer bot, which drives
 * the real game controller (controller.actNow). On every new area the renderer's last-frame cost is
 * recorded (draw calls, triangles). End screens go to test-results/shots/M5-dod/ (never docs/).
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/dod/playwright.dod.config.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = join(ROOT, 'test-results/shots/M5-dod');
mkdirSync(OUT, { recursive: true });

const WORLDS = readdirSync(join(ROOT, 'content/worlds'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
const LANG: Record<string, string> = Object.fromEntries(
  WORLDS.map((id) => [id, (JSON.parse(readFileSync(join(ROOT, `content/worlds/${id}.json`), 'utf8')).meta.language as string | undefined) ?? 'en']),
);

/** per-frame budget used for the audit (render-mobile.spec.ts uses 250 draw calls for the fixtures) */
const DRAW_CALL_BUDGET = 250;
const TRIANGLE_BUDGET = 1_500_000;

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

async function prepare(page: Page, lang: string) {
  await page.addInitScript((l) => {
    try {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', l);
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
}

interface PlayResult {
  status: string;
  turn: number;
  areas: number;
  steps: number;
  cost: { area: number; drawCalls: number; triangles: number }[];
  endVisible: boolean;
  layer: string;
}

const results: Record<string, PlayResult & { errors: number }> = {};

test.describe.configure({ mode: 'serial' });

for (const id of WORLDS) {
  test(`DoD: ${id} plays start to finish in the browser`, async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page, LANG[id]!.split('-')[0]!);
    await page.goto('/');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const card = page.locator(`.aw-demo[data-world="${id}"]`);
    if ((await card.count()) === 0) {
      // translated copies are listed only in their language's UI; fall back to the direct link
      await page.goto(`/?world=${id}`);
    } else {
      await card.click();
    }
    await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.worldId)).toBe(id);

    const botPath = '/@fs' + join(ROOT, 'src/engine/sim/bots.ts');
    const res: PlayResult = await page.evaluate(async (botPath) => {
      const mod = (await import(/* @vite-ignore */ botPath)) as typeof import('../../../../src/engine/sim/bots');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = window.__anyworld!.controller as any;
      const bot = mod.botByName('explorer');
      const mem = mod.newMemory(7);
      const cost: PlayResult['cost'] = [];
      let lastArea = -1;
      let steps = 0;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (c.session.state.status === 'playing' && steps < 6000) {
        const st = c.session.state;
        if (st.area.index !== lastArea) {
          lastArea = st.area.index;
          await sleep(400);
          const s = c.host.renderer.stats();
          cost.push({ area: lastArea, drawCalls: s.drawCalls, triangles: s.triangles });
        }
        const a = bot.decide(c.session.state, c.session.world, mem);
        c.actNow(a);
        steps++;
        if (steps % 40 === 0) await sleep(5);
      }
      await sleep(1500);
      const end = document.querySelector('.aw-end, [data-layer="end"], .aw-endscreen');
      const ui = window.__anyworld!.ui as unknown as { layer(): string };
      return {
        status: c.session.state.status,
        turn: c.session.state.turn,
        areas: lastArea + 1,
        steps,
        cost,
        endVisible: !!end && (end as HTMLElement).offsetParent !== null,
        layer: ui.layer(),
      };
    }, botPath);
    await page.screenshot({ path: join(OUT, `${id}-end.png`) });
    results[id] = { ...res, errors: errors.length };
    writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`${id}: ${res.status} turn ${res.turn}, areas ${res.areas}, steps ${res.steps}, layer ${res.layer}, cost ${res.cost.map((x) => `${x.drawCalls}c/${x.triangles}t`).join(' ')}`);
    expect(['won', 'lost']).toContain(res.status);
    expect(res.layer).toBe('end');
    for (const k of res.cost) {
      expect(k.drawCalls, `${id} area ${k.area} draw calls`).toBeLessThan(DRAW_CALL_BUDGET);
      expect(k.triangles, `${id} area ${k.area} triangles`).toBeLessThan(TRIANGLE_BUDGET);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
