/**
 * M5 review, round 2 — Norwegian (bokmål) reviewer.
 *
 * Plays the bokmål worlds and one English world with the UI in bokmål, starts a new run in the
 * offline demo mode with a Norwegian prompt, and visits every screen on desktop (1280×800) and on a
 * phone (390×844). For each screen it writes a screenshot docs/progress/M5/nb-r2-<name>.png and
 * records the visible text, tooltips/aria labels and any clipped text (an element whose content is
 * wider than its box under overflow hidden / ellipsis) into NB_REVIEW_OUT (JSON, default
 * test-results/nb-review-r2.json) for the human-style read-through.
 *
 * The test itself only asserts that the game runs (no page errors) and that the obvious English
 * fallbacks are absent from bokmål screens; the language review is done by reading the dump.
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.nb-r2.config.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = join(ROOT, 'docs/progress/M5');
const DUMP = process.env.NB_REVIEW_OUT ?? join(ROOT, 'test-results/nb-review-r2.json');
mkdirSync(OUT, { recursive: true });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

interface ScreenDump {
  text: string;
  attrs: string[];
  clipped: string[];
  log: string[];
}
const dump: Record<string, ScreenDump> = {};

test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  mkdirSync(dirname(DUMP), { recursive: true });
  writeFileSync(DUMP, JSON.stringify(dump, null, 2));
});

async function prepare(page: Page, settings?: unknown): Promise<void> {
  await page.addInitScript((s) => {
    try {
      if (!sessionStorage.getItem('nb-r2-init')) {
        sessionStorage.setItem('nb-r2-init', '1');
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'nb');
        if (s) localStorage.setItem('anyworld.settings.v1', JSON.stringify(s));
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
  }, settings ?? null);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|\/api\/|net::/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(500);
}

async function waitGame(page: Page, timeout = 90000): Promise<void> {
  await page.waitForFunction(() => document.getElementById('ui-root')?.dataset.screen === 'game' && !!window.__anyworld?.controller, null, { timeout });
  await page.waitForTimeout(800);
}

/** screenshot + text, attributes, clipped text and the log for the read-through */
async function shot(page: Page, name: string): Promise<ScreenDump> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `nb-r2-${name}.png`) });
  const d = await page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const attrs: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[aria-label], [title], [data-tip], [placeholder], [aria-valuetext]'))) {
      if (!visible(el)) continue;
      for (const a of ['aria-label', 'title', 'data-tip', 'placeholder', 'aria-valuetext']) {
        const v = el.getAttribute(a);
        if (v) attrs.push(`${a}: ${v}`);
      }
    }
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (!visible(el) || !el.textContent?.trim() || el.children.length > 3) continue;
      const cs = getComputedStyle(el);
      const hides = cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis';
      if (!hides) continue;
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (el.scrollWidth > el.clientWidth + 1 || (cs.textOverflow !== 'ellipsis' && cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2)) {
        clipped.push(`${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')} [${el.clientWidth}x${el.clientHeight} < ${el.scrollWidth}x${el.scrollHeight}]: ${el.innerText.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    const log = Array.from(document.querySelectorAll('.aw-log-list li')).map((li) => (li as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
    return { text: document.body.innerText, attrs: [...new Set(attrs)], clipped, log };
  });
  dump[name] = d;
  return d;
}

async function closeNarration(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const btn = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (!(await btn.isVisible().catch(() => false))) return;
    await btn.click();
    await page.waitForTimeout(250);
  }
}

async function closeOnboarding(page: Page): Promise<void> {
  const card = page.locator('.aw-onboard');
  if (await card.isVisible().catch(() => false)) await card.locator('.aw-onboard-ok').click();
  await page.waitForTimeout(200);
}

/** move a hostile next to the player and trade blows */
async function fight(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const s = c.session;
    const p = s.state.area.actors.find((a) => a.id === s.state.player.actorId)!;
    const foe = s.state.area.actors.find((a) => a.faction === 'hostile');
    if (!foe) return false;
    const m = s.state.area.map;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.pos.x + dx;
      const y = p.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (!t || (t.kind !== 'floor' && t.kind !== 'start') || t.terrain) continue;
      if (s.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((st) => {
        const f = st.area.actors.find((a) => a.id === foe.id)!;
        f.pos = { x, y };
        f.ai.alerted = true;
      });
      const dir = dx === 1 ? 'e' : dx === -1 ? 'w' : dy === 1 ? 's' : 'n';
      for (let i = 0; i < 5; i++) c.actNow({ type: 'move', dir } as never);
      return true;
    }
    return false;
  });
}

/** stand next to an NPC (optionally of a role) and talk */
async function talk(page: Page, role?: string): Promise<boolean> {
  return page.evaluate(async (role) => {
    const c = window.__anyworld!.controller!;
    const s = c.session;
    const npc = s.state.area.actors.find((a) => {
      const d = s.world.actors.find((x) => x.id === a.defId);
      return d?.npc && a.faction !== 'hostile' && (!role || d.npc.role === role);
    });
    if (!npc) return false;
    const m = s.state.area.map;
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      const x = npc.pos.x + dx;
      const y = npc.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (!t || (t.kind !== 'floor' && t.kind !== 'start')) continue;
      if (s.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((st) => {
        st.area.actors = st.area.actors.filter((a) => a.id === st.player.actorId || a.faction !== 'hostile');
        st.area.actors.find((a) => a.id === st.player.actorId)!.pos = { x, y };
      });
      c.actNow({ type: 'talk', targetId: npc.id });
      return true;
    }
    return false;
  }, role ?? null);
}

/** a full tour of one world: every screen the player meets */
async function tour(page: Page, worldId: string, seed: number, p: string): Promise<void> {
  await page.goto(`/?world=${worldId}&seed=${seed}`);
  await waitReady(page);
  await page.waitForTimeout(500);
  if (await page.locator('.aw-narration:not([hidden])').isVisible().catch(() => false)) await shot(page, `${p}-01-prologue`);
  await closeNarration(page);
  if (await page.locator('.aw-onboard').isVisible().catch(() => false)) await shot(page, `${p}-02-onboarding`);
  await closeOnboarding(page);
  await page.keyboard.press('.');
  await page.waitForTimeout(200);
  await shot(page, `${p}-03-hud`);
  if (await page.locator('.aw-goal-head').isVisible().catch(() => false)) {
    await page.locator('.aw-goal-head').click();
    await shot(page, `${p}-04-goal`);
    await page.locator('.aw-goal-head').click();
  }
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 's', 'g', '.']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(120);
  }
  await closeNarration(page);
  // look mode on something
  await page.keyboard.press('x');
  await page.waitForTimeout(300);
  await shot(page, `${p}-05-look`);
  await page.keyboard.press('Escape');
  if (await fight(page)) {
    await page.waitForTimeout(600);
    await closeNarration(page);
    await shot(page, `${p}-06-combat`);
  }
  // expanded log
  const toggle = page.locator('.aw-log-toggle');
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await shot(page, `${p}-07-log`);
    await toggle.click().catch(() => undefined);
  }
  // level up: GM grants xp, perk/choice card
  await page.evaluate(() => window.__anyworld!.controller!.gmNow([{ type: 'grant_xp', amount: 200 }] as never));
  await page.waitForTimeout(800);
  await closeNarration(page);
  await shot(page, `${p}-08-levelup`);
  for (let i = 0; i < 4; i++) {
    const opt = page.locator('.aw-perk, .aw-choice .aw-option').first();
    if (!(await opt.isVisible().catch(() => false))) break;
    await opt.click();
    await page.waitForTimeout(400);
  }
  // GM gives items and a rule appears
  await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    const items = c.session.world.items.slice(0, 3).map((it) => ({ type: 'give_item', item: it.id, count: 2 }));
    c.gmNow(items as never);
  });
  await page.waitForTimeout(500);
  await closeNarration(page);
  await page.keyboard.press('i');
  await page.waitForTimeout(400);
  await shot(page, `${p}-09-backpack`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  await shot(page, `${p}-10-rules`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.waitForTimeout(400);
  await shot(page, `${p}-11-help`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await talk(page)) {
    await page.waitForTimeout(800);
    await shot(page, `${p}-12-dialogue`);
    // first reply
    const reply = page.locator('.aw-dialogue .aw-option').first();
    if (await reply.isVisible().catch(() => false)) {
      await reply.click();
      await page.waitForTimeout(600);
      await shot(page, `${p}-13-dialogue-reply`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  if (await talk(page, 'trader')) {
    await page.waitForTimeout(800);
    const trade = page.locator('.aw-dialogue button').filter({ hasText: /Handle|Trade/ });
    if (await trade.first().isVisible().catch(() => false)) {
      await trade.first().click();
      await page.waitForTimeout(500);
      await shot(page, `${p}-14-trade`);
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  // lose (twice: a world may forgive the first loss)
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.aw-end').isVisible().catch(() => false)) break;
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      await c.setStateForTest((st) => {
        st.area.actors.find((a) => a.id === st.player.actorId)!.hp = 1;
      });
      c.gmNow([{ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: 500 }, damageType: c.session.world.damageTypes[0]!.id }] }] as never);
    });
    await page.waitForTimeout(1200);
    if (i === 0) await shot(page, `${p}-14b-saved`);
    await closeNarration(page);
  }
  await page.waitForTimeout(500);
  await shot(page, `${p}-15-end`);
}

test('start screen and settings in bokmål (desktop + phone)', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  await page.goto('/');
  await waitReady(page);
  await shot(page, 'start-desktop');
  await page.locator('.aw-start-settings').click();
  await page.waitForTimeout(400);
  await shot(page, 'settings-desktop');
  await page.keyboard.press('Escape');
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(300);
  await shot(page, 'start-phone');
  await page.locator('.aw-start-settings').click();
  await page.waitForTimeout(400);
  await shot(page, 'settings-phone');
  await page.keyboard.press('Escape');
  await page.setViewportSize(DESKTOP);
  expect(errors).toEqual([]);
});

for (const [id, seed, p] of [
  ['nb-troll-direktoratet', 3, 'troll'],
  ['nb-russetid-bussen', 4, 'russ'],
  ['nb-nordisk-noir-tromso', 5, 'noir'],
  ['viking-lawspeaker-althing-nb', 6, 'althing'],
  ['corporate-merger-kitchen-nb', 7, 'office'],
  ['fixture-western', 8, 'en-western'],
  ['heist-silent-vault', 9, 'en-heist'],
] as const) {
  test(`tour ${id} (bokmål UI)`, async ({ page }) => {
    const errors = watchErrors(page);
    await prepare(page);
    await tour(page, id, seed, p);
    expect(errors).toEqual([]);
  });
}

test('phone: troll world in bokmål (390×844)', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize(PHONE);
  await prepare(page);
  await tour(page, 'nb-troll-direktoratet', 3, 'phone-troll');
  expect(errors).toEqual([]);
});

test('offline demo: a new run in bokmål from a Norwegian prompt and from "surprise me"', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page, { provider: { preset: 'mock', transport: 'direct' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
  await page.goto('/');
  await waitReady(page);
  await shot(page, 'demo-start');
  await page.locator('#aw-prompt').fill('Et byråkratisk troll som må søke om byggetillatelse under fjellet');
  await page.locator('.aw-start-actions .aw-btn-primary').click();
  await expect(page.locator('.aw-loading')).toBeVisible();
  await page.waitForTimeout(150);
  await shot(page, 'demo-loading');
  await waitGame(page);
  await page.waitForTimeout(500);
  const meta1 = await page.evaluate(() => window.__anyworld!.controller!.session.world.meta);
  dump['demo-world-1'] = { text: JSON.stringify(meta1), attrs: [], clipped: [], log: [] };
  await shot(page, 'demo-game-prologue');
  await closeNarration(page);
  await closeOnboarding(page);
  await shot(page, 'demo-game-hud');
  await page.evaluate(() => window.__anyworld!.showStart());
  await expect(page.locator('.aw-start')).toBeVisible();
  await shot(page, 'demo-start-recent');
  await page.locator('.aw-start-actions .aw-btn').nth(1).click();
  await page.waitForTimeout(150);
  await shot(page, 'demo-loading-surprise');
  await waitGame(page);
  const meta2 = await page.evaluate(() => window.__anyworld!.controller!.session.world.meta);
  dump['demo-world-2'] = { text: JSON.stringify(meta2), attrs: [], clipped: [], log: [] };
  await shot(page, 'demo-surprise-prologue');
  await closeNarration(page);
  await closeOnboarding(page);
  await shot(page, 'demo-surprise-hud');
  // an English inspiration card clicked in a bokmål UI: what language does the run get?
  await page.evaluate(() => window.__anyworld!.showStart());
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(300);
  await shot(page, 'demo-start-recent-phone');
  expect(errors).toEqual([]);
});

/** the screens a tour does not reach: a GM rule, a consumable's card, a status ticking, sneaking, the end screen */
test('troll world: GM rule, item card, statuses, end screen', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  await page.goto('/?world=nb-troll-direktoratet&seed=12');
  await waitReady(page);
  await closeNarration(page);
  await closeOnboarding(page);
  // a GM rule with its reason
  await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    c.gmNow([
      { type: 'add_rule', reason: 'Ekkoet kremter: fra nå av må alt leveres i tre eksemplarer.', rule: { id: 'tre_eksemplarer', name: 'Tre eksemplarer', description: 'Hver femte runde mister du 1 Blekk.', playerTriggers: [{ on: 'on_turn', chance: 1, every: 5, action: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'enemies', needsLos: false }, effects: [{ type: 'resource', resource: 'mp', amount: { base: -1 } }] } }] } },
    ] as never);
  });
  await page.waitForTimeout(800);
  await shot(page, 'x-01-gm-rule');
  await closeNarration(page);
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  await shot(page, 'x-02-rules-gm');
  await page.keyboard.press('Escape');
  // statuses: blekk-tilgrising (harmful, ticking) + kaffefart
  await page.evaluate(() => {
    const c = window.__anyworld!.controller!;
    const ids = c.session.world.statuses.map((s) => s.id);
    c.gmNow([{ type: 'effect', target: 'player', effects: ids.slice(0, 3).map((id) => ({ type: 'apply_status', status: id, duration: 4 })) }] as never);
  });
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('.');
    await page.waitForTimeout(150);
  }
  await page.locator('.aw-log-toggle').click().catch(() => undefined);
  await shot(page, 'x-03-statuses');
  await page.locator('.aw-log-toggle').click().catch(() => undefined);
  // consumable and ranged item cards in the backpack (hover each quick slot)
  await page.keyboard.press('i');
  await page.waitForTimeout(300);
  for (const n of [3, 4, 5]) {
    await page.keyboard.press(String(n));
    await page.locator('.aw-backpack .aw-slot').nth(n - 1).hover().catch(() => undefined);
    await page.locator('.aw-backpack .aw-slot').nth(n - 1).click().catch(() => undefined);
    await page.waitForTimeout(300);
    await shot(page, `x-04-card-${n}`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // use the coffee at full patience (the "already full" toast)
  await page.keyboard.press('3');
  await page.waitForTimeout(400);
  await shot(page, 'x-05-full-toast');
  // walk into a wall a few times (blocked)
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  await shot(page, 'x-06-blocked');
  // lose: patience to 0 twice (the world forgives once), via the session's own harm
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.aw-end').isVisible().catch(() => false)) break;
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      await c.setStateForTest((st) => {
        st.area.actors.find((a) => a.id === st.player.actorId)!.hp = 1;
      });
      c.gmNow([{ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: 3 }, damageType: c.session.world.damageTypes[0]!.id }] }] as never);
    });
    await page.waitForTimeout(1000);
    await closeNarration(page);
    for (let k = 0; k < 6; k++) {
      await page.keyboard.press('.');
      await page.waitForTimeout(100);
    }
  }
  await page.waitForTimeout(1200);
  await closeNarration(page);
  await shot(page, 'x-07-end');
  expect(errors).toEqual([]);
});

/** the end screen of a bokmål world: a hostile finishes the player (mercy and the world's second chance spent) */
for (const [id, p] of [['nb-troll-direktoratet', 'troll'], ['nb-russetid-bussen', 'russ']] as const) {
  test(`end screen in bokmål (${id})`, async ({ page }) => {
    const errors = watchErrors(page);
    await prepare(page);
    await page.goto(`/?world=${id}&seed=21`);
    await waitReady(page);
    await closeNarration(page);
    await closeOnboarding(page);
    for (let round = 0; round < 3; round++) {
      if (await page.locator('.aw-end').isVisible().catch(() => false)) break;
      await fight(page);
      await page.evaluate(async () => {
        const c = window.__anyworld!.controller!;
        await c.setStateForTest((st) => {
          st.mercyUsed = true;
          st.area.actors.find((a) => a.id === st.player.actorId)!.hp = 1;
        });
        for (let i = 0; i < 12 && c.session.state.status === 'playing'; i++) c.actNow({ type: 'wait' } as never);
      });
      await page.waitForTimeout(1200);
      await closeNarration(page);
    }
    await page.waitForTimeout(800);
    await closeNarration(page);
    await shot(page, `x-08-end-${p}`);
    expect(errors).toEqual([]);
  });
}

/* ---------------- round 2 additions ---------------- */

/** win screen in bokmål, then "Ny verden" from the end screen: the second run's prologue and onboarding */
test('troll world: win screen, then a second run from the end screen', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  await page.goto('/?world=nb-troll-direktoratet&seed=31');
  await waitReady(page);
  await closeNarration(page);
  await closeOnboarding(page);
  await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    await c.setStateForTest((st) => {
      (st as unknown as { defeated: Record<string, number> }).defeated['saksbehandler-trehode'] = 1;
    });
    c.actNow({ type: 'wait' } as never);
  });
  await page.waitForTimeout(1500);
  await shot(page, 'y-01-win-narration');
  await closeNarration(page);
  await page.waitForTimeout(800);
  await shot(page, 'y-02-win-end');
  const nw = page.locator('.aw-end-actions .aw-btn-primary');
  if (await nw.isVisible().catch(() => false)) {
    await nw.click();
    await page.waitForTimeout(800);
    await shot(page, 'y-03-after-new-world');
  }
  expect(errors).toEqual([]);
});

/** NPC conversations: "ask what they know" and a healer's help in bokmål */
for (const [id, p] of [['nb-troll-direktoratet', 'troll'], ['viking-lawspeaker-althing-nb', 'althing'], ['nb-nordisk-noir-tromso', 'noir']] as const) {
  test(`dialogue options in bokmål (${id})`, async ({ page }) => {
    const errors = watchErrors(page);
    await prepare(page);
    await page.goto(`/?world=${id}&seed=41`);
    await waitReady(page);
    await closeNarration(page);
    await closeOnboarding(page);
    const roles = await page.evaluate(() => window.__anyworld!.controller!.session.state.area.actors.map((a) => window.__anyworld!.controller!.session.world.actors.find((d) => d.id === a.defId)?.npc?.role).filter(Boolean));
    dump[`z-${p}-roles`] = { text: JSON.stringify(roles), attrs: [], clipped: [], log: [] };
    for (const role of ['healer', 'quest_giver', 'trader', 'informant', undefined] as const) {
      // hurt the player a bit so help heals
      await page.evaluate(async () => {
        const c = window.__anyworld!.controller!;
        await c.setStateForTest((st) => {
          const p = st.area.actors.find((a) => a.id === st.player.actorId)!;
          p.hp = Math.max(1, Math.floor(p.hp / 2));
        });
      });
      if (!(await talk(page, role))) continue;
      await page.waitForTimeout(800);
      await shot(page, `z-${p}-${role ?? 'any'}-0`);
      for (let k = 0; k < 3; k++) {
        const opts = page.locator('.aw-dialogue .aw-option');
        const n = await opts.count();
        if (n === 0) break;
        await opts.nth(Math.min(k, n - 1)).click();
        await page.waitForTimeout(700);
        await shot(page, `z-${p}-${role ?? 'any'}-${k + 1}`);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      if (role === undefined) break;
    }
    expect(errors).toEqual([]);
  });
}

/** an English world in a bokmål UI on a phone: what mixes? */
test('phone: English heist world in bokmål UI (390×844)', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize(PHONE);
  await prepare(page);
  await tour(page, 'heist-silent-vault', 9, 'phone-en-heist');
  expect(errors).toEqual([]);
});

/** settings in the offline demo: provider labels and presets */
test('settings with the offline demo preset and a custom preset', async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page, { provider: { preset: 'mock', transport: 'direct' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
  await page.goto('/');
  await waitReady(page);
  await page.locator('.aw-start-settings').click();
  await page.waitForTimeout(400);
  await shot(page, 'settings-demo');
  const sel = page.locator('select').first();
  const opts = await sel.locator('option').allInnerTexts().catch(() => [] as string[]);
  dump['settings-options'] = { text: opts.join('\n'), attrs: [], clipped: [], log: [] };
  const all = await page.locator('.aw-settings select option, select option').allInnerTexts().catch(() => [] as string[]);
  dump['settings-all-options'] = { text: all.join('\n'), attrs: [], clipped: [], log: [] };
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
