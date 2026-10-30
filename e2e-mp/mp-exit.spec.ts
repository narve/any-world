/**
 * MP3 exit check (MULTIPLAYER-PLAN §3, MP3 design §7): three players in one browser — A and B on
 * desktop 1280×800, C on a phone 390×844 — play one run together and chat.
 *
 * A creates a room from the start page (code, link and QR in the lobby), B opens the link and picks
 * a name and colour, C types the code on the start page; all three ready and A starts. Then A moves
 * with the keyboard, C with taps and B clicks to travel; B's page shows the turn pill while A acts
 * and A's turns resolve without B; A opens the chat with Enter and types (the letters never move A),
 * B sees the "…" and the line; C sends 👍 and a "Follow me" ping from the phone's chat sheet and A
 * and B get them. The rest of the run is played by the in-page autoplay (a sim bot per page through
 * the session, `__anyworld.room.autoplay`), with a chat line about every 40 entries; every page sees
 * the exit countdown banner, the three replicas agree on the hash after every area change and at
 * the end, the end screen offers "Play again" (the host) and the room block (the others), and A
 * plays again: all three are in the new run's first area.
 *
 * A sampler in each page records what was on screen between the test's looks (the pill, typing,
 * bubbles, the exit banner), so short-lived UI is checked without fixed sleeps.
 * Screenshots go to test-results/shots/MP3.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { Pos } from '../src/engine/types';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { createRoom, layer, myPlayer, newPage, PHONE, ready, room, screen, toGameLayer } from './mates';

const OUT = 'test-results/shots/MP3';
mkdirSync(OUT, { recursive: true });

interface Sampled {
  pills: string[];
  typing: string[];
  bubbles: string[];
  exit: string[];
}

/** records, every 40 ms, the short-lived room UI of the page (deduplicated) */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __mp?: { s: Record<string, string[]>; timer: number } };
    if (w.__mp) clearInterval(w.__mp.timer);
    const s: Record<string, string[]> = { pills: [], typing: [], bubbles: [], exit: [] };
    const add = (k: string, v: string) => {
      if (v && !s[k].includes(v) && s[k].length < 200) s[k].push(v);
    };
    const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).checkVisibility?.() !== false && (el as HTMLElement).getClientRects().length > 0;
    const timer = window.setInterval(() => {
      const r = window.__anyworld?.room;
      if (!r) return;
      for (const sel of ['.aw-slot-pill .aw-turn-pill', '.aw-strip-turn']) {
        const el = document.querySelector(sel);
        if (shown(el)) add('pills', el.textContent ?? '');
      }
      for (const seat of r.link.chat.typing(Date.now())) add('typing', seat);
      for (const b of r.bubbles()) add('bubbles', `${b.seat}|${b.kind}|${b.text}`);
      const ex = document.querySelector('.aw-slot-banner .aw-party-banner[data-kind="exit"]');
      if (shown(ex)) add('exit', ex.textContent ?? '');
    }, 40);
    w.__mp = { s, timer };
  });
}

const sampled = (page: Page) => page.evaluate(() => (window as unknown as { __mp: { s: Sampled } }).__mp.s);

/** the room's n and hash, read together */
const nHash = (page: Page) => room(page, (r) => ({ n: r.n, hash: r.hash(), run: r.run, area: r.state()?.area.index ?? -1, status: r.state()?.status ?? '' }));

/** waits until the pages have the same newest entry, then compares their hashes */
async function sameHash(pages: Page[], timeout = 20_000): Promise<string> {
  let last: { n: number; hash: string | null }[] = [];
  await expect
    .poll(
      async () => {
        last = await Promise.all(pages.map(nHash));
        return last.every((x) => x.n === last[0].n);
      },
      { timeout },
    )
    .toBe(true);
  expect(new Set(last.map((x) => x.hash)).size).toBe(1);
  return last[0].hash!;
}

/** a seen floor tile `minD`–`maxD` steps from the page's player, and a point on screen that picks it */
const stepTile = (page: Page, minD: number, maxD: number) =>
  page.evaluate(([lo, hi]) => {
    const app = window.__anyworld!;
    const s = app.controller!.session.state;
    const me = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
    const m = s.area.map;
    const seen = s.players[s.party[0]].seen as ArrayLike<number>;
    for (let d = lo; d <= hi; d++)
      for (let y = me.pos.y - d; y <= me.pos.y + d; y++)
        for (let x = me.pos.x - d; x <= me.pos.x + d; x++) {
          if (x < 0 || y < 0 || x >= m.width || y >= m.height || Math.max(Math.abs(x - me.pos.x), Math.abs(y - me.pos.y)) !== d) continue;
          const t = m.tiles[y * m.width + x];
          if (seen[y * m.width + x] !== 2 || (t.kind !== 'floor' && t.kind !== 'start') || s.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
          const r = app.renderer!;
          const p = r.tileToScreen({ x, y });
          if (p.x < 40 || p.y < 120 || p.x > innerWidth - 40 || p.y > innerHeight - 200 || !document.elementFromPoint(p.x, p.y)?.closest('#game-canvas')) continue;
          // (the point picks that tile: no wall or actor in front of it)
          const hit = r.pick(p.x, p.y);
          if (hit && hit.x === x && hit.y === y) return { tile: { x, y }, screen: p };
        }
    return null;
  }, [minD, maxD] as const);

const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;

test.describe.configure({ mode: 'serial' });

test('three players (two desktops, a phone) play one run together, chat, ping, see the exit countdown, agree on hashes and play again', async ({ browser }) => {
  test.setTimeout(540_000);
  const A = await newPage(browser, {}, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  const B = await newPage(browser);
  const C = await newPage(browser, PHONE, { name: 'Siv', colour: PLAYER_COLOURS[5] });
  const pages = [A.page, B.page, C.page];

  // --- A creates the room: code, link and QR code in the lobby ---
  const code = await createRoom(A.page);
  await expect(A.page.locator('.aw-lobby-link')).toHaveValue(new RegExp(`\\?room=${code}$`));
  await expect(A.page.locator('.aw-lobby-qr svg path')).toHaveCount(1);
  const link = await A.page.locator('.aw-lobby-link').inputValue();

  // --- B opens the link: the name sheet, a name and a colour ---
  await B.page.goto(new URL(link).pathname + new URL(link).search);
  await ready(B.page);
  await expect(B.page.locator('.aw-profile-sheet')).toBeVisible({ timeout: 20_000 });
  // (a click into the field and typing replaces the offered "Player 12", MP5)
  await B.page.locator('#aw-profile-name').click();
  await B.page.keyboard.type('Ola');
  await expect(B.page.locator('#aw-profile-name')).toHaveValue('Ola');
  await B.page.locator(`.aw-swatch[data-colour="${PLAYER_COLOURS[2]}"]`).click();
  await B.page.locator('.aw-profile-go').click();
  await expect(B.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });

  // --- C types the code on the phone's start page (the stored profile: no sheet) ---
  await C.page.goto('/');
  await ready(C.page);
  await C.page.locator('#aw-room-code').fill(code.toLowerCase());
  await C.page.locator('.aw-room-join-btn').tap();
  await expect(C.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => room(A.page, (r) => r.roster().map((x) => `${x.name} ${x.colour}`).sort().join(', '))).toBe(
    [`Kari ${PLAYER_COLOURS[0]}`, `Ola ${PLAYER_COLOURS[2]}`, `Siv ${PLAYER_COLOURS[5]}`].sort().join(', '),
  );

  // --- all three ready; A starts ---
  await A.page.locator('.aw-lobby-ready').click();
  await B.page.locator('.aw-lobby-ready').click();
  await C.page.locator('.aw-lobby-ready').tap();
  await expect(A.page.locator('.aw-lobby-count')).toHaveText('3 of 3 ready');
  await C.page.screenshot({ path: `${OUT}/exit-lobby-phone.png` });
  await A.page.locator('.aw-lobby-start').click();
  for (const p of pages) await expect.poll(() => screen(p), { timeout: 60_000 }).toBe('game');
  for (const p of pages) await toGameLayer(p);
  await sameHash(pages);
  const seat = { A: (await room(A.page, (r) => r.seat))!, B: (await room(B.page, (r) => r.seat))!, C: (await room(C.page, (r) => r.seat))! };
  for (const p of pages) await startSampler(p);

  // --- C moves with a tap next to its player ---
  const c0 = await myPlayer(C.page);
  const tap = await stepTile(C.page, 1, 1);
  expect(tap).not.toBeNull();
  await C.page.touchscreen.tap(tap!.screen.x, tap!.screen.y);
  // (the first touch can shift the camera's insets a little, so the step is not always onto that very tile)
  await expect.poll(async () => !samePos(await myPlayer(C.page), c0), { timeout: 15_000 }).toBe(true);
  // (C's own player moved: each page plays its own pid)
  expect(c0.pid).toBe(await room(C.page, (r) => r.pid));
  expect(c0.pid).not.toBe((await myPlayer(A.page)).pid);

  // --- B clicks a tile a few steps away and walks there (a travel step per turn) ---
  const b0 = await myPlayer(B.page);
  const dest = await stepTile(B.page, 2, 4);
  expect(dest).not.toBeNull();
  await B.page.mouse.click(dest!.screen.x, dest!.screen.y);
  await expect.poll(async () => !samePos(await myPlayer(B.page), b0), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => B.page.evaluate(() => !window.__anyworld!.controller!.session.travelDest), { timeout: 20_000 }).toBe(true);

  // --- A moves with the keys; B and C send nothing: A's turns resolve at the deadline, B sees the pill ---
  const a0 = await myPlayer(A.page);
  const bStill = await myPlayer(B.page);
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', '.', '.']) {
    await A.page.keyboard.press(key);
    await A.page.waitForTimeout(800);
  }
  const a1 = await myPlayer(A.page);
  expect(a1.turn - a0.turn).toBeGreaterThanOrEqual(3);
  expect(samePos(await myPlayer(B.page), bStill)).toBe(true);
  expect((await sampled(B.page)).pills.some((x) => /of 3 acted|is deciding/.test(x))).toBe(true);
  await B.page.screenshot({ path: `${OUT}/exit-pill-desktop.png` });

  // --- A chats: Enter, the letters do not move A, B sees "…" then the line ---
  await toGameLayer(A.page);
  await A.page.keyboard.press('Enter');
  await expect(A.page.locator('.aw-slot-side .aw-chat-input')).toBeFocused();
  const aBefore = await myPlayer(A.page);
  await A.page.keyboard.type('wasd hello', { delay: 80 });
  await A.page.waitForTimeout(300);
  await A.page.keyboard.press('Enter');
  await expect.poll(() => room(B.page, (r) => r.chat().map((l) => l.text))).toContain('wasd hello');
  const aAfter = await myPlayer(A.page);
  expect(samePos(aAfter, aBefore)).toBe(true);
  expect(await A.page.evaluate(() => window.__anyworld!.room!.session?.queued ?? null)).toBeNull();
  expect((await sampled(B.page)).typing).toContain(seat.A);
  if (await room(B.page, (r, s) => r.onScreen(s), seat.A)) await expect.poll(async () => (await sampled(B.page)).bubbles).toContain(`${seat.A}|bubble|wasd hello`);
  else await expect(B.page.locator('.aw-slot-side .aw-chat-line', { hasText: 'wasd hello' })).toBeVisible();
  // a bubble on screen is never under a HUD panel (its top would be: it goes under the feet then)
  for (const p of [A.page, B.page]) {
    const bubble = p.locator('.aw-party-overlay .aw-bubble', { hasText: 'wasd hello' });
    if (!(await bubble.count())) continue;
    const over = await bubble.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = (o: DOMRect) => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top;
      return window.__anyworld!.ui.panelRects().hud.filter(hit).length;
    });
    expect(over).toBe(0);
  }
  await B.page.screenshot({ path: `${OUT}/exit-chat-desktop.png` });

  // --- C: the chat sheet, 👍 and a "Follow me" ping; A and B get both ---
  await C.page.locator('.aw-hotbar-tools .aw-chat-button').tap();
  const sheet = C.page.locator('.aw-chat-sheet');
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-emote="👍"]').tap();
  await C.page.waitForTimeout(1100);
  await sheet.locator('[data-ping="follow"]').tap();
  for (const p of [A.page, B.page]) {
    await expect.poll(() => room(p, (r) => r.chat().map((l) => l.text))).toContain('👍');
    await expect.poll(() => room(p, (r) => r.link.chat.lines.some((l) => l.ping?.kind === 'follow'))).toBe(true);
  }
  await expect(A.page.locator('.aw-slot-side .aw-chat-line.is-ping')).toContainText('Follow me');
  await C.page.screenshot({ path: `${OUT}/exit-sheet-phone.png` });
  await sheet.locator('.aw-chat-close').tap();
  await expect(sheet).toBeHidden();
  await sameHash(pages);

  // --- the rest of the run: the in-page autoplay on all three, a chat line about every 40 entries ---
  const bots = ['explorer', 'cautious', 'explorer'] as const;
  const t0 = Date.now();
  for (const [i, p] of pages.entries()) await room(p, (r, o) => r.autoplay(true, o), { bot: bots[i], seed: 11 + i, chatEvery: 40 });
  const ended = (p: Page) => room(p, (r) => r.phase === 'ended' || (r.state()?.status ?? 'playing') !== 'playing');
  let shotAt = -1;
  await expect
    .poll(
      async () => {
        const all = await Promise.all(pages.map(ended));
        // a look at the phone now and then (the first areas)
        const area = (await nHash(C.page)).area;
        if (area !== shotAt && area >= 1 && shotAt < 2) {
          shotAt = area;
          await C.page.screenshot({ path: `${OUT}/exit-autoplay-phone-area${area}.png` });
          await A.page.screenshot({ path: `${OUT}/exit-autoplay-desktop-area${area}.png` });
        }
        return all.every(Boolean);
      },
      { timeout: 420_000, intervals: [1000] },
    )
    .toBe(true);
  console.log(`[mp-exit] autoplay run took ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const p of pages) await room(p, (r) => r.autoplay(false));

  // the run's last entry: the same n and hash everywhere
  const endHash = await sameHash(pages, 30_000);
  const stats = await Promise.all(pages.map((p) => room(p, (r) => r.autoplayStats()!)));
  for (const s of stats) {
    console.log(`[mp-exit] autoplay: sent ${s.sent}, refused here ${s.refused} ${JSON.stringify(s.refusals)}, by the server ${s.serverRefused}, said ${s.said}`);
    expect(s.faults).toEqual([]);
    expect(s.sent).toBeGreaterThan(20);
  }
  // every area change (and the end) has the same n and hash on all three
  const marks = stats.map((s) => s.areas.map((m) => `${m.area}@${m.n}:${m.hash}`));
  expect(marks[0].length).toBeGreaterThanOrEqual(2);
  expect(marks[1]).toEqual(marks[0]);
  expect(marks[2]).toEqual(marks[0]);
  expect(stats[0].areas.at(-1)!.hash).toBe(endHash);
  // the exit countdown banner was on every screen
  for (const p of pages) expect((await sampled(p)).exit.some((x) => /moves on in/.test(x))).toBe(true);
  // the bots chatted: A got lines from B and C
  const aChat = await room(A.page, (r) => r.chat());
  for (const name of ['Ola', 'Siv']) expect(aChat.some((l) => l.name === name && l.text.startsWith('autoplay at'))).toBe(true);
  expect(stats.reduce((a, s) => a + s.said, 0)).toBeGreaterThanOrEqual(3);

  // --- the end screen: "Play again" for the host, the room block for the others ---
  for (const p of pages) await expect.poll(() => screen(p), { timeout: 20_000 }).toBe('end');
  await expect(A.page.locator('.aw-end-again')).toBeVisible();
  await expect(B.page.locator('.aw-end-room .aw-lobby-ready')).toBeVisible();
  await expect(C.page.locator('.aw-end-room .aw-lobby-ready')).toBeVisible();
  await expect(B.page.locator('.aw-end-again')).toHaveCount(0);
  await A.page.screenshot({ path: `${OUT}/exit-end-desktop.png` });
  await C.page.screenshot({ path: `${OUT}/exit-end-phone.png` });

  // --- A plays again: all three in the new run's first area ---
  const run0 = (await nHash(A.page)).run;
  await A.page.locator('.aw-end-again').click();
  for (const p of pages) {
    await expect.poll(async () => (await nHash(p)).run, { timeout: 30_000 }).toBe(run0 + 1);
    await expect.poll(() => screen(p), { timeout: 60_000 }).toBe('game');
  }
  for (const p of pages) {
    const h = await nHash(p);
    expect(h.area).toBe(0);
    expect(h.status).toBe('playing');
    expect(await p.evaluate(() => window.__anyworld!.room!.session?.run)).toBe(run0 + 1);
  }
  await sameHash(pages);
  expect(await layer(C.page)).not.toBe('loading');
  await C.page.screenshot({ path: `${OUT}/exit-again-phone.png` });

  for (const p of [A, B, C]) expect(p.errors).toEqual([]);
  for (const p of [A, B, C]) await p.ctx.close();
});
