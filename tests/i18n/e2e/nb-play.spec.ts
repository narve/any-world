/**
 * Norwegian playthrough (DESIGN §7b, DoD #11): the UI in bokmål playing a bokmål world. Every
 * screen is screenshotted to docs/archive/progress/M4/nb-*.png and its visible text is scanned for English
 * that leaked past the catalog (UI chrome, log lines, vocabulary fallbacks).
 *
 * Leaks are collected per screen into NB_LEAKS_OUT (a JSON file, default
 * test-results/nb-leaks.json) so the remaining ones can be listed with their source; the test fails
 * on leaks from text this role owns (the nb catalog and the translated worlds).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = join(ROOT, process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M4' : 'test-results/shots/M4');
const LEAKS_OUT = process.env.NB_LEAKS_OUT ?? join(ROOT, 'test-results/nb-leaks.json');
mkdirSync(OUT, { recursive: true });

/** English words that never belong in bokmål UI text (whole words, case-sensitive starts allowed) */
const ENGLISH = /\b(the|The|you|You|your|Your|and|with|press|Press|click|Click|tap|Tap|turn|Turn|turns|level|Level|items?|slot|Slot|backpack|Backpack|rules?|Rules?|goal|Goal|nothing|Nothing|someone|Someone|Ask|Goodbye|Offer|Wait|Search|Talk|Pick up|Use|Close|Continue|Skip|Settings|Language|Difficulty|Weirdness|Inspiration|Demo|worlds?|Worlds?|picks up|takes|misses|appears|of|are|from|here|Here|Blocked|direction|trader|healer|informant|quest giver|Health|Strength|Mana|Armour|Victory)\b/;
/** proper nouns / loanwords from the worlds that look English but are not leaks */
const ALLOW = /Halberd & Pike( Mutual)?|Greyline( Assurance)?|Pip Okonedo-Marsh|Pax tibi|AnyWorld|SoundCloud|OpenAI|localStorage|CORS|API|URL|#REF!/g;

const leaks: Record<string, string[]> = {};

function scan(screen: string, text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(ALLOW, '').trim();
    if (!line) continue;
    if (ENGLISH.test(line)) found.push(raw.trim());
  }
  const uniq = [...new Set(found)];
  if (uniq.length) leaks[screen] = [...new Set([...(leaks[screen] ?? []), ...uniq])];
  return uniq;
}

/** visible overlay text (the WebGL canvas has none) plus titles and aria labels of visible controls */
async function overlayText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.body.innerText];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-label], [title], [data-tip], [placeholder]'))) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      for (const a of ['aria-label', 'title', 'data-tip', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
}

/**
 * Engine-made English that the client does not route through the catalog yet (owned elsewhere; the
 * keys and helpers exist in src/client/i18n/engine-text.ts). Listed so they are reported, not fatal.
 */
const KNOWN_ELSEWHERE = /^(Blocked|Bad direction|Something is in the way|No one there)( ×\d+)?$|^(trader|healer|informant|rival|ally|lore|quest giver)$|^(Ask what they know|Goodbye|Ask for help|Offer to help|Ask them to come along|Leave)$/;

/** screenshot + scan; returns the leaks that are not known to come from elsewhere */
async function shotAndScan(page: Page, name: string): Promise<string[]> {
  await page.screenshot({ path: join(OUT, `nb-${name}.png`) });
  return scan(name, await overlayText(page)).filter((l) => !KNOWN_ELSEWHERE.test(l));
}

/** shotAndScan, failing on any leak this role does not know about */
async function check(page: Page, name: string): Promise<void> {
  expect(await shotAndScan(page, name), `English on screen ${name}`).toEqual([]);
}

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('nb-init')) {
      try {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'nb');
      } catch {
        /* storage blocked */
      }
      sessionStorage.setItem('nb-init', '1');
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

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(600);
}

async function closeNarration(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const btn = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (!(await btn.isVisible().catch(() => false))) return;
    await btn.click();
    await page.waitForTimeout(250);
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|\/api\//.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  mkdirSync(dirname(LEAKS_OUT), { recursive: true });
  writeFileSync(LEAKS_OUT, JSON.stringify(leaks, null, 2));
});

test('start screen in bokmål', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  await page.goto('/');
  await page.waitForTimeout(1500);
  await shotAndScan(page, '01-start');
  await expect(page.getByText('Ferdige verdener').first()).toBeVisible();
  // the translated demo worlds are listed under Norwegian
  await expect(page.getByText('Hver paragraf binder').first()).toBeVisible();
  await expect(page.getByText('Nøytral grunn: kjøkkenet i tredje').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('play the bokmål Althing world with the UI in bokmål', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  await page.goto('/?world=viking-lawspeaker-althing-nb&seed=11');
  await waitReady(page);

  // prologue (the world's own Norwegian GM text)
  await expect(page.locator('.aw-narration')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.aw-narration')).toContainText('Det er sagt i loven');
  await check(page, '02-prologue');
  await closeNarration(page);

  // onboarding card
  const card = page.locator('.aw-onboard');
  if (await card.isVisible().catch(() => false)) {
    await expect(card).toContainText('Slik vinner du');
    await expect(card).toContainText('Gjendriv');
    await check(page, '03-onboarding');
    await card.locator('.aw-onboard-ok').click();
  }

  // HUD, goal tracker, hotbar, context bar
  await expect(page.locator('.aw-goal')).toBeVisible();
  await page.keyboard.press('.');
  await page.keyboard.press('.');
  await page.waitForTimeout(300);
  await expect(page.locator('.aw-hud')).toContainText('hos lovsigemannen');
  await check(page, '04-hud');
  await page.locator('.aw-goal-head').click();
  await page.waitForTimeout(300);
  await check(page, '05-goal');
  await page.locator('.aw-goal-head').click();

  // walk about a little (log lines from the engine through the nb catalog)
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 's', '.']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(120);
  }

  // a fight: put a hostile next to the player and trade blows
  const fought = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const s = c.session;
    const p = s.state.area.actors.find((a) => a.id === s.state.players[s.state.party[0]].actorId)!;
    const foe = s.state.area.actors.find((a) => a.faction === 'hostile');
    if (!foe) return false;
    const m = s.state.area.map;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.pos.x + dx;
      const y = p.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (!t || t.kind !== 'floor' || t.terrain) continue;
      if (s.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((st) => {
        const f = st.area.actors.find((a) => a.id === foe.id)!;
        f.pos = { x, y };
        f.ai.alerted = true;
      });
      const dir = dx === 1 ? 'e' : dx === -1 ? 'w' : dy === 1 ? 's' : 'n';
      for (let i = 0; i < 4; i++) c.actNow({ type: 'move', dir } as never);
      return true;
    }
    return false;
  });
  expect(fought).toBe(true);
  await page.waitForTimeout(600);
  const log = page.locator('.aw-log');
  await expect(log).toBeVisible();
  await check(page, '06-combat-log');
  const logText = await log.innerText();
  expect(logText).toMatch(/Steinunn|Anseelse|nedstemt|bommer/);

  // backpack, rules, help
  await page.keyboard.press('i');
  await page.waitForTimeout(400);
  await expect(page.locator('.aw-backpack')).toBeVisible();
  await expect(page.locator('.aw-backpack')).toContainText('Ryggsekk');
  await check(page, '07-backpack');
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  await check(page, '08-rules');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.waitForTimeout(500);
  await expect(page.locator('.aw-help')).toContainText('Kontroller');
  await check(page, '09-help');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // a conversation with a friendly NPC (offline: the world's own lines)
  const talked = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const s = c.session;
    const npc = s.state.area.actors.find((a) => a.faction !== 'hostile' && s.world.actors.find((d) => d.id === a.defId)?.npc);
    if (!npc) return false;
    const m = s.state.area.map;
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      const x = npc.pos.x + dx;
      const y = npc.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (!t || (t.kind !== 'floor' && t.kind !== 'start') || t.terrain) continue;
      if (s.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((st) => {
        st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId || a.faction !== 'hostile');
        st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.pos = { x, y };
      });
      c.actNow({ type: 'talk', targetId: npc.id });
      return true;
    }
    return false;
  });
  expect(talked).toBe(true);
  await page.waitForTimeout(800);
  await expect(page.locator('.aw-dialogue')).toBeVisible();
  await check(page, '10-dialogue');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // lose the run: the end screen
  await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    await c.setStateForTest((st) => {
      st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.hp = 1;
    });
    c.gmNow([{ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: 50 }, damageType: c.session.world.damageTypes[0]!.id }] }]);
  });
  await page.waitForTimeout(1200);
  await closeNarration(page);
  await expect(page.locator('.aw-end')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.aw-end')).toContainText('Overdøvet');
  await check(page, '11-end');
  expect(errors).toEqual([]);
});

test('office world: trade and the world vocabulary in bokmål', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  await page.goto('/?world=corporate-merger-kitchen-nb&seed=5');
  await waitReady(page);
  await closeNarration(page);
  const card = page.locator('.aw-onboard');
  if (await card.isVisible().catch(() => false)) await card.locator('.aw-onboard-ok').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.aw-hud')).toContainText('Koffein');
  await check(page, '12-office-hud');

  // talk to Maureen (the trader): role buttons and prices
  const talked = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const s = c.session;
    const npc = s.state.area.actors.find((a) => s.world.actors.find((d) => d.id === a.defId)?.npc?.role === 'trader');
    if (!npc) return false;
    const m = s.state.area.map;
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      const x = npc.pos.x + dx;
      const y = npc.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (!t || (t.kind !== 'floor' && t.kind !== 'start')) continue;
      if (s.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((st) => {
        st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId || a.faction !== 'hostile');
        st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.pos = { x, y };
      });
      c.actNow({ type: 'talk', targetId: npc.id });
      return true;
    }
    return false;
  });
  expect(talked).toBe(true);
  await page.waitForTimeout(800);
  await check(page, '13-office-dialogue');
  const trade = page.locator('.aw-dialogue .aw-btn, .aw-dialogue button').filter({ hasText: /Handle/ });
  if (await trade.first().isVisible().catch(() => false)) {
    await trade.first().click();
    await page.waitForTimeout(500);
    await check(page, '14-office-trade');
  }
  expect(errors).toEqual([]);
});
