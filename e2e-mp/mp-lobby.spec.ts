/**
 * MP3 D3: the start page's rooms and the lobby, in real browsers against the room server
 * (playwright.mp.config.ts). "Play with friends" on a world card creates a room (the name sheet the
 * first time), the room shows on another page's list and is joined from there, a name clash gives
 * "You are Kari 2" with Change, ready count, the host starts, each page plays its own player, a
 * third page opens the link mid-run and lands in the game with a character, the host leaves and
 * the player connected longest becomes host, a reload rejoins the same seat, "Leave room" from the in-game menu
 * keeps the single-player save; the server down → "unavailable" (single player still starts),
 * an outdated server → Reload, ?room=ZZZZ → "no room with that code".
 * Screenshots go to test-results/shots/MP3.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'test-results/shots/MP3';
mkdirSync(OUT, { recursive: true });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function newPage(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('mp-init')) return;
    sessionStorage.setItem('mp-init', '1');
    localStorage.setItem('anyworld.settings.v1', JSON.stringify({ quality: 'low', reduceMotion: true, audio: { volume: 0, muted: true } }));
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60_000 });
}

const screen = (page: Page) => page.evaluate(() => document.getElementById('ui-root')?.dataset.screen ?? '');
const room = (page: Page) =>
  page.evaluate(() => {
    const r = window.__anyworld?.room;
    return r ? { code: r.code, status: r.status, phase: r.phase, seat: r.seat, pid: r.pid, host: r.host, n: r.n, run: r.run, roster: r.roster() } : null;
  });

/** the name sheet: type a name and go */
async function answerSheet(page: Page, name: string): Promise<void> {
  const sheet = page.locator('.aw-profile-sheet');
  await expect(sheet).toBeVisible();
  await page.locator('#aw-profile-name').fill(name);
  await page.locator('.aw-profile-go').click();
}

/** the played player's own position in the session's view (state is the perspective: party[0] is this player) */
const myPlayer = (page: Page) =>
  page.evaluate(() => {
    const s = window.__anyworld!.controller!.session.state;
    const me = s.players[s.party[0]];
    const a = s.area.actors.find((x) => x.id === me.actorId)!;
    return { pid: s.party[0], x: a.pos.x, y: a.pos.y, turn: s.turn };
  });

test.describe.configure({ mode: 'serial' });

test('create from a world card, join from the list, clash, ready, start, mid-run join, host leaves, reload, Leave room', async ({ browser }) => {
  test.setTimeout(240_000);
  const A = await newPage(browser);
  const B = await newPage(browser);

  // --- A: "Play with friends" on a world card (the name sheet the first time) ---
  await A.page.goto('/');
  await ready(A.page);
  await expect(A.page.locator('.aw-rooms')).toBeVisible();
  await expect(A.page.locator('.aw-rooms')).toHaveAttribute('data-status', 'ok');
  await A.page.locator('[data-friends="fixture-western"]').click();
  await answerSheet(A.page, 'Kari');
  await expect(A.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  const code = (await A.page.locator('.aw-lobby-code').textContent())!.trim();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
  expect(A.page.url()).toContain(`?room=${code}`);
  await expect(A.page.locator('.aw-lobby-link')).toHaveValue(new RegExp(`\\?room=${code}$`));
  await expect(A.page.locator('.aw-lobby-qr svg path')).toHaveCount(1);
  // (the e2e-mp server runs with the GM off: the "reads the chat" line is for the AI GM only, mp-gm.spec.ts)
  await expect(A.page.locator('.aw-lobby-gm')).toBeHidden();
  await expect(A.page.locator('.aw-lobby-start')).toBeVisible();
  await A.page.screenshot({ path: `${OUT}/lobby-host-desktop.png` });

  // --- B: the room on the start page's list; Join; the same name → "You are Kari 2" with Change ---
  await B.page.goto('/');
  await ready(B.page);
  const row = B.page.locator(`.aw-room-row[data-code="${code}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('1/8');
  await B.page.screenshot({ path: `${OUT}/start-rooms-desktop.png` });
  await row.locator('button').click();
  await answerSheet(B.page, 'Kari');
  await expect(B.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  const toast = B.page.locator('.aw-toast.has-action', { hasText: 'You are Kari 2' });
  await expect(toast).toBeVisible();
  await toast.locator('.aw-toast-action').click();
  await expect(B.page.locator('.aw-profile-sheet')).toBeVisible();
  await answerSheet(B.page, 'Ola');
  await expect.poll(async () => (await room(A.page))?.roster.map((r) => r.name).sort().join(','), { timeout: 10_000 }).toBe('Kari,Ola');
  // names are text, never markup
  await expect(A.page.locator('.aw-roster-name', { hasText: 'Ola' })).toHaveCount(1);
  expect((await room(B.page))?.host).toBe(false);
  await expect(B.page.locator('.aw-lobby-waiting')).toBeVisible();

  // --- ready count; the host starts (never gated on ready) ---
  await B.page.locator('.aw-lobby-ready').click();
  await expect(A.page.locator('.aw-lobby-count')).toHaveText('1 of 2 ready');
  await B.page.screenshot({ path: `${OUT}/lobby-guest-desktop.png` });
  await A.page.locator('.aw-lobby-start').click();
  await expect.poll(() => screen(A.page), { timeout: 60_000 }).toBe('game');
  await expect.poll(() => screen(B.page), { timeout: 60_000 }).toBe('game');
  const ra = (await room(A.page))!;
  const rb = (await room(B.page))!;
  expect(ra.pid).toBeTruthy();
  expect(rb.pid).toBeTruthy();
  expect(ra.pid).not.toBe(rb.pid);
  // each page plays its own player (the view's lead is this page's pid)
  expect((await myPlayer(A.page)).pid).toBe(ra.pid);
  expect((await myPlayer(B.page)).pid).toBe(rb.pid);
  expect(B.page.url()).toContain(`?room=${code}`);

  // B moves with the keyboard: B's own character moves (A's page did nothing), and both replicas agree
  for (let i = 0; i < 4 && (await B.page.evaluate(() => window.__anyworld!.ui.layer())) !== 'game'; i++) {
    await B.page.keyboard.press('Escape');
    await B.page.waitForTimeout(150);
  }
  const startB = await myPlayer(B.page);
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight']) {
    await B.page.keyboard.press(key);
    await B.page.waitForTimeout(250);
  }
  await expect.poll(async () => {
    const p = await myPlayer(B.page);
    return p.x !== startB.x || p.y !== startB.y || p.turn > startB.turn;
  }, { timeout: 15_000 }).toBe(true);
  // (the moves were B's: A's page sent nothing, so A has nothing queued)
  expect(await A.page.evaluate(() => window.__anyworld!.room!.session?.queued ?? null)).toBeNull();
  await expect.poll(async () => {
    const [a, b] = await Promise.all([A.page.evaluate(() => [window.__anyworld!.room!.n, window.__anyworld!.room!.hash()]), B.page.evaluate(() => [window.__anyworld!.room!.n, window.__anyworld!.room!.hash()])]);
    return a[0] === b[0] && a[1] === b[1];
  }, { timeout: 15_000 }).toBe(true);
  const bInA = await A.page.evaluate((pid) => {
    const s = window.__anyworld!.room!.state()!;
    return s.area.actors.find((x) => x.id === s.players[pid].actorId)!.pos;
  }, rb.pid!);
  const bSelf = await myPlayer(B.page);
  expect(bInA).toEqual({ x: bSelf.x, y: bSelf.y });
  await A.page.screenshot({ path: `${OUT}/game-host-desktop.png` });

  // --- C (phone): a single-player run first (its save must survive), then the link mid-run ---
  const C = await newPage(browser, PHONE);
  await C.page.goto('/?world=fixture-ship&seed=5');
  await ready(C.page);
  await C.page.evaluate(() => window.__anyworld!.controller!.actNow({ type: 'wait' }));
  const saved = await C.page.evaluate(() => JSON.parse(localStorage.getItem('anyworld.save.v1') ?? 'null')?.turn ?? null);
  expect(saved).not.toBeNull();
  await C.page.goto(`/?room=${code}`);
  await answerSheet(C.page, 'Nora');
  await expect.poll(() => screen(C.page), { timeout: 60_000 }).toBe('game');
  const rc = (await room(C.page))!;
  expect(rc.pid).toBeTruthy();
  expect([ra.pid, rb.pid]).not.toContain(rc.pid);
  // the joiner has a character on the map, in everyone's replica
  await expect.poll(() => A.page.evaluate((pid) => !!window.__anyworld!.room!.state()!.players[pid], rc.pid!), { timeout: 15_000 }).toBe(true);
  await C.page.screenshot({ path: `${OUT}/game-latejoin-phone.png` });

  // --- a reload rejoins the same seat ---
  await B.page.reload();
  await expect.poll(async () => (await room(B.page))?.status, { timeout: 30_000 }).toBe('joined');
  expect((await room(B.page))!.seat).toBe(rb.seat);
  expect((await room(B.page))!.pid).toBe(rb.pid);
  await expect.poll(() => screen(B.page), { timeout: 60_000 }).toBe('game');

  // --- the host leaves: the room goes on, the player connected longest becomes host (C: B reconnected after it joined) ---
  await A.page.evaluate(() => window.__anyworld!.leaveRoom());
  await expect.poll(() => screen(A.page)).toBe('start');
  await expect.poll(async () => (await room(B.page))?.roster.find((r) => r.host)?.seat, { timeout: 15_000 }).toBe(rc.seat);
  await expect.poll(async () => (await room(C.page))?.host, { timeout: 15_000 }).toBe(true);

  // --- C leaves through the in-game menu (help → Leave room): start page, the single-player save untouched ---
  // (a script click: on the phone the intro card may still cover the hotbar)
  await C.page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('.aw-hotbar button.aw-icon-btn'));
    btns.find((b) => /help/i.test(b.getAttribute('aria-label') ?? ''))?.click();
  });
  await expect(C.page.locator('.aw-help-leave')).toBeVisible({ timeout: 10_000 });
  await C.page.screenshot({ path: `${OUT}/help-leave-phone.png` });
  await C.page.locator('.aw-help-leave').click();
  await expect.poll(() => screen(C.page)).toBe('start');
  expect(await C.page.evaluate(() => window.__anyworld!.room)).toBeNull();
  expect(C.page.url()).not.toContain('room=');
  expect(await C.page.evaluate(() => JSON.parse(localStorage.getItem('anyworld.save.v1') ?? 'null')?.turn ?? null)).toBe(saved);
  await expect(C.page.locator('.aw-saved-card')).toBeVisible();
  await C.page.screenshot({ path: `${OUT}/start-phone.png` });

  for (const p of [A, B, C]) expect(p.errors).toEqual([]);
  for (const p of [A, B, C]) await p.ctx.close();
});

test('phone lobby by code; the end of a link: a code with no room', async ({ browser }) => {
  const H = await newPage(browser);
  await H.page.goto('/');
  await ready(H.page);
  await H.page.locator('.aw-room-create').click();
  await answerSheet(H.page, 'Host');
  await expect(H.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  const code = (await H.page.locator('.aw-lobby-code').textContent())!.trim();

  const P = await newPage(browser, PHONE);
  await P.page.goto('/');
  await ready(P.page);
  await P.page.locator('#aw-room-code').fill(code.toLowerCase());
  await expect(P.page.locator('#aw-room-code')).toHaveValue(code);
  await P.page.locator('.aw-room-join-btn').click();
  await answerSheet(P.page, 'Phone');
  await expect(P.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  await expect(P.page.locator('.aw-roster-row')).toHaveCount(2);
  await P.page.screenshot({ path: `${OUT}/lobby-phone.png`, fullPage: true });
  // nothing in the lobby is wider than the phone
  const overflow = await P.page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.aw-lobby')!;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // ?room=ZZZZ: back to the start page with the notice
  const Z = await newPage(browser);
  await Z.page.goto('/?room=ZZZZ');
  await ready(Z.page);
  await expect(Z.page.locator('.aw-toast', { hasText: 'no room with that code' })).toBeVisible({ timeout: 15_000 });
  expect(await screen(Z.page)).toBe('start');

  for (const p of [H, P, Z]) expect(p.errors).toEqual([]);
  for (const p of [H, P, Z]) await p.ctx.close();
});

test('server down → rooms unavailable and single player still starts; an outdated server → Reload', async ({ browser }) => {
  const D = await newPage(browser);
  await D.page.route('**/api/rooms**', (r) => r.abort());
  await D.page.route('**/api/health', (r) => r.abort());
  await D.page.goto('/');
  await ready(D.page);
  await expect(D.page.locator('.aw-rooms')).toHaveAttribute('data-status', 'unavailable', { timeout: 15_000 });
  await expect(D.page.locator('.aw-rooms')).toContainText('unavailable');
  await expect(D.page.locator('.aw-room-create')).toBeDisabled();
  await expect(D.page.locator('[data-friends]')).toHaveCount(0);
  await D.page.screenshot({ path: `${OUT}/start-unavailable-desktop.png` });
  await D.page.locator('.aw-demo[data-world="fixture-western"]').click();
  await expect.poll(() => screen(D.page), { timeout: 60_000 }).toBe('game');

  const O = await newPage(browser);
  await O.page.route('**/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, engine: 'some-other-engine' }) }));
  await O.page.goto('/');
  await ready(O.page);
  await expect(O.page.locator('.aw-rooms')).toHaveAttribute('data-status', 'outdated', { timeout: 15_000 });
  await expect(O.page.locator('.aw-rooms button', { hasText: 'Reload' })).toBeVisible();

  for (const p of [D, O]) expect(p.errors).toEqual([]);
  for (const p of [D, O]) await p.ctx.close();
});
