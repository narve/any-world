/**
 * M5 review round 2, client fixes in the browser:
 *  - issues/M5-ranged-keyboard-fire.md         press the equipped gun's key, Enter fires at range
 *  - issues/M5-api-key-leaks-across-presets.md switching preset never sends the old key to the new host
 * Screenshots: docs/progress/M5/client-r2-*.png
 *
 * Run: xvfb-run -a npx playwright test e2e/m5-client-r2.spec.ts
 * M5_BASE=http://localhost:<port> points it at another dev server.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';


// review screenshots go to test-results; SHOTS_TO_DOCS=1 writes the committed milestone copies
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M5' : 'test-results/shots/m5-client-r2';
mkdirSync(OUT, { recursive: true });
if (process.env.M5_BASE) test.use({ baseURL: process.env.M5_BASE });

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

async function fresh(page: Page, settings?: unknown): Promise<void> {
  await page.addInitScript((st) => {
    if (!sessionStorage.getItem('r2c-init')) {
      sessionStorage.setItem('r2c-init', '1');
      localStorage.clear();
      localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
      localStorage.setItem('anyworld.lang.v1', 'en');
      if (st) localStorage.setItem('anyworld.settings.v1', JSON.stringify(st));
    }
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, settings ?? null);
}

async function intoGame(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if ((await layer(page)) === 'narration') {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
      continue;
    }
    const ok = page.locator('.aw-onboard:not([hidden]) .aw-onboard-ok');
    if (await ok.isVisible().catch(() => false)) {
      await ok.click();
      await page.waitForTimeout(250);
      continue;
    }
    break;
  }
}

test('the equipped gun fires at range from the keyboard: its key aims, Enter shoots', async ({ page }) => {
  await fresh(page);
  await page.goto('/?world=fixture-western&seed=3');
  await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__anyworld?.controller != null, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await intoGame(page);
  // one deputy four tiles east of the player on a clear line, everyone else gone
  const setup = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    let out: { gun: number; id: string } | null = null;
    await c.setStateForTest((s) => {
      const st = s as unknown as {
        players: Record<string, { actorId: string; slots: ({ defId: string } | null)[]; equipped: { weapon: number | null } }>;
        party: string[];
        area: { map: { width: number; tiles: { kind: string }[] }; actors: { id: string; defId: string; pos: { x: number; y: number }; faction: string }[] };
      };
      const me = st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!;
      const w = st.area.map.width;
      const floor = (x: number, y: number) => ['floor', 'start', 'door'].includes(st.area.map.tiles[y * w + x]?.kind ?? 'wall');
      let at: { x: number; y: number } | null = null;
      for (let y = 1; y < st.area.map.tiles.length / w - 1 && !at; y++)
        for (let x = 1; x < w - 6 && !at; x++) if ([0, 1, 2, 3, 4].every((d) => floor(x + d, y))) at = { x, y };
      const dep = st.area.actors.find((a) => a.defId === 'company-deputy') ?? st.area.actors.find((a) => a.faction === 'hostile')!;
      st.area.actors = st.area.actors.filter((a) => a === me || a === dep);
      me.pos = { ...at! };
      dep.pos = { x: at!.x + 4, y: at!.y };
      out = { gun: st.players[st.party[0]].equipped.weapon ?? -1, id: dep.id };
    });
    return out!;
  });
  expect(setup.gun).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('.'); // wait a turn: field of view refreshes
  await page.waitForTimeout(300);
  await page.keyboard.press(String(setup.gun + 1));
  await expect.poll(() => layer(page)).toBe('target');
  const aim = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    const dep = s.state.area.actors.find((a) => a.faction === 'hostile');
    return { cursor: s.cursor, dep: dep?.pos, firing: s.firingWeapon() };
  });
  expect(aim.firing).toBe(true);
  expect(aim.cursor).toEqual(aim.dep);
  await page.screenshot({ path: `${OUT}/client-r2-aim-gun.png` });
  const turn = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
  await page.keyboard.press('Enter');
  await expect.poll(() => layer(page)).toBe('game');
  const after = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    return { turn: s.state.turn, log: s.state.log.slice(-6).map((m) => m.text).join(' | ') };
  });
  expect(after.turn).toBeGreaterThan(turn);
  expect(after.log).toMatch(/shoots|misses|Peacemaker/i);
  await page.screenshot({ path: `${OUT}/client-r2-fired-gun.png` });
});

test("switching preset does not keep or send the previous provider's key", async ({ page }) => {
  const SECRET = 'sk-ant-review-secret-0123456789';
  await fresh(page, { provider: { preset: 'anthropic', transport: 'direct', apiKey: SECRET } });
  const seen: string[] = [];
  await page.route('https://openrouter.ai/**', async (route) => {
    seen.push(route.request().headers()['authorization'] ?? '');
    await route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: '{"error":{"message":"bad key"}}' });
  });
  await page.goto('/');
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.locator('.aw-start-settings').click();
  await expect(page.locator('#aw-set-preset')).toBeVisible();
  await page.locator('#aw-set-preset').selectOption('openrouter');
  await page.locator('#aw-set-transport-direct').check();
  await page.locator('#aw-set-save').click();
  await expect(page.locator('#aw-set-preset')).toBeHidden();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('anyworld.settings.v1') ?? '{}'));
  expect(stored.provider.preset).toBe('openrouter');
  expect(stored.provider.apiKey ?? null).toBeNull();
  expect(stored.apiKeys).toEqual({ anthropic: SECRET });
  // reopening the dialog shows an empty key field for OpenRouter
  await page.locator('.aw-start-settings').click();
  await expect(page.locator('#aw-set-key')).toHaveValue('');
  await page.keyboard.press('Escape');
  await page.locator('#aw-prompt').fill('A teen drama at a flooded school');
  await page.getByRole('button', { name: 'Create world' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/client-r2-no-key-leak.png` });
  expect(seen.filter((a) => a.includes(SECRET))).toEqual([]);
});
