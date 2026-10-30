/**
 * MP3 D4: the in-game party UI in a real browser (playwright.mp.config.ts), one page plus scripted
 * teammates (mates.ts): the rings in the seat colours, name tags, the party strip, the turn pill
 * while an active teammate has not acted ("Ola is deciding") and no wait once the teammates are
 * idle, a teammate away (socket dropped) and back, the exit-countdown banner, and the spectator:
 * a Hard room (no second chance) where the teammates walk away and stay in a menu (busy, so no
 * hostile picks them) while the page's player waits next to the nearest hostile, which makes it the
 * only target; once it is down the banner says so, the camera follows a teammate, `]` switches to
 * the other one, and after the self-revive turns (the teammates wait) the camera comes back.
 * The order of events and the spectator rules are unit-tested in room-session / party-view.
 * Screenshots go to test-results/shots/MP3.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { bfsDistances, passability } from '../src/engine/index';
import type { Dir, GameState, Pos } from '../src/engine/types';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { createRoom, layer, Mate, newPage, room, startRun } from './mates';

const OUT = 'test-results/shots/MP3';
mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: 'serial' });

const DIRS: [Dir, number, number][] = [['n', 0, -1], ['s', 0, 1], ['e', 1, 0], ['w', -1, 0], ['ne', 1, -1], ['nw', -1, -1], ['se', 1, 1], ['sw', -1, 1]];

/** ring colours of the renderer's views by actor id */
const rings = (page: Page) =>
  page.evaluate(() => {
    const views = (window.__anyworld!.renderer as unknown as { actors: { views: Map<string, { ringMat: { color: { getHexString(): string } }; isPlayer: boolean }> } }).actors.views;
    return Object.fromEntries([...views].map(([id, v]) => [id, { ring: `#${v.ringMat.color.getHexString()}`, isPlayer: v.isPlayer }]));
  });

const chipState = (page: Page, name: string) => page.locator('.aw-strip .aw-party-chip', { hasText: name }).getAttribute('data-state');

test('rings, tags, strip, turn pill, idle teammates, away and back, exit countdown', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const A = await newPage(browser, {}, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  const code = await createRoom(A.page);
  const ola = await new Mate(baseURL!, code, 'Ola', PLAYER_COLOURS[2]).join();
  const siv = await new Mate(baseURL!, code, 'Siv', PLAYER_COLOURS[5]).join();
  await startRun(A.page);
  await ola.inRun();
  await siv.inRun();

  // --- rings in the seat colours (own included), name tags over the teammates, three chips ---
  const s = ola.state!;
  const byActor = (pid: string) => s.players[pid].actorId;
  const roster = ola.client.roster;
  await expect
    .poll(async () => {
      const r = await rings(A.page);
      return roster.every((e) => r[byActor(e.pid!)]?.ring === e.colour.toLowerCase());
    })
    .toBe(true);
  const kariPid = roster.find((e) => e.name === 'Kari')!.pid!;
  expect((await rings(A.page))[byActor(kariPid)].isPlayer).toBe(true);
  await expect(A.page.locator('.aw-party-overlay .aw-name-tag', { hasText: 'Ola' })).toBeVisible();
  await expect(A.page.locator('.aw-party-overlay .aw-name-tag', { hasText: 'Siv' })).toBeVisible();
  await expect(A.page.locator('.aw-party-overlay .aw-name-tag', { hasText: 'Kari' })).toHaveCount(0);
  await expect(A.page.locator('.aw-strip .aw-party-chip')).toHaveCount(3);
  await expect(A.page.locator('.aw-strip .aw-party-chip.is-you')).toContainText('Kari');

  // --- the pill: the teammates act and the turn waits on A ("2 of 3 acted"); then A acts first while they
  //     are still active and the turn waits on them ("Ola is deciding"); keys still work meanwhile ---
  const pill = A.page.locator('.aw-slot-pill .aw-turn-pill');
  const catchPill = () => pill.waitFor({ state: 'visible', timeout: 1500 }).then(() => pill.textContent(), () => '');
  let seen = '';
  /** the page and the mates have the same newest entry, and no turn is waiting */
  const settled = async () => {
    await expect.poll(() => room(A.page, (r) => r.n)).toBeGreaterThanOrEqual(ola.client.n);
    await expect(pill).toBeHidden({ timeout: 5000 });
  };
  for (let i = 0; i < 6 && !/of 3 acted/.test(seen); i++) {
    // A acts (an input keeps a seat active for a while); the turn resolves (at the deadline at most)
    const n0 = ola.client.n;
    await A.page.keyboard.press('.');
    await expect.poll(() => ola.client.n > n0, { timeout: 10_000 }).toBe(true);
    await settled();
    ola.client.input([{ type: 'wait' }], 'wait');
    siv.client.input([{ type: 'wait' }], 'wait');
    seen = (await catchPill()) ?? '';
  }
  await settled();
  expect(seen).toMatch(/2 of 3 acted/);
  let deciding = '';
  for (let i = 0; i < 8 && !deciding; i++) {
    // the teammates are active (a presence message counts), A acts first on a fresh turn
    ola.client.presence('playing');
    siv.client.presence('playing');
    const n0 = ola.client.n;
    await A.page.keyboard.press('.');
    deciding = (await catchPill()) ?? '';
    await expect.poll(() => ola.client.n > n0, { timeout: 10_000 }).toBe(true);
    await settled();
  }
  expect(deciding).toMatch(/(Ola|Siv) is deciding/);
  await A.page.screenshot({ path: `${OUT}/party-pill-desktop.png` });
  // the pill hides once the turn resolved (the deadline)
  await expect(pill).toBeHidden({ timeout: 5000 });

  // --- idle teammates hold nothing up: A's turns resolve at once, no pill ---
  await A.page.waitForTimeout(10_500);
  const t0 = s.turn;
  const turnOf = () => room(A.page, (r) => r.state()!.turn);
  const before = await turnOf();
  for (let i = 0; i < 4; i++) {
    await A.page.keyboard.press('.');
    await A.page.waitForTimeout(250);
  }
  expect((await turnOf()) - before).toBeGreaterThanOrEqual(3);
  await expect(pill).toBeHidden();
  expect(t0).toBeLessThanOrEqual(before);

  // --- a teammate away (socket gone) and back ---
  ola.client.stop();
  await expect.poll(() => chipState(A.page, 'Ola'), { timeout: 15_000 }).toBe('away');
  await expect(A.page.locator('.aw-party-overlay :is(.aw-name-tag, .aw-edge-arrow).is-away', { hasText: 'Ola' })).toBeVisible();
  await A.page.screenshot({ path: `${OUT}/party-away-desktop.png` });
  ola.client.connect();
  await expect.poll(() => chipState(A.page, 'Ola'), { timeout: 15_000 }).not.toBe('away');

  // --- Siv walks to the exit and takes it: the countdown banner on A's page ---
  const exit = siv.state!.area.map.exit;
  const area = siv.state!.area.index;
  await siv.walkTo(exit, { steps: 120 });
  await expect.poll(() => siv.pos(), { timeout: 5000 }).toEqual(exit);
  siv.client.input([{ type: 'transition' }], 'decide');
  const banner = A.page.locator('.aw-slot-banner .aw-party-banner[data-kind="exit"]');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('Siv took the exit: the party moves on in');
  // (on top: a narration card never hides it)
  expect(await banner.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })).toBe(true);
  await A.page.screenshot({ path: `${OUT}/party-exit-desktop.png` });
  // the countdown runs out and the party is pulled along (the turns are paced by the server)
  await expect.poll(() => room(A.page, (r) => r.state()!.area.index), { timeout: 30_000 }).toBe(area + 1);
  await expect(banner).toBeHidden();

  expect(A.errors).toEqual([]);
  ola.leave();
  siv.leave();
  await A.ctx.close();
});

/** the next step from `from` toward `to` over the replica's passable tiles (8 directions) */
function stepToward(s: GameState, world: NonNullable<Mate['client']['world']>, from: Pos, to: Pos): Dir | null {
  const w = s.area.map.width;
  const dist = bfsDistances(w, s.area.map.height, to, passability(s, { world }));
  let best: Dir | null = null;
  let bestD = dist[from.y * w + from.x];
  const occupied = new Set(s.area.actors.filter((a) => a.hp > 0).map((a) => a.pos.y * w + a.pos.x));
  for (const [d, dx, dy] of DIRS) {
    const i = (from.y + dy) * w + (from.x + dx);
    if (dist[i] >= 0 && dist[i] < bestD && !occupied.has(i)) [best, bestD] = [d, dist[i]];
  }
  return best;
}

test('spectator: down in a Hard room, the camera follows a teammate, ] cycles, back on getting up (bounded 90 s)', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const started = Date.now();
  const A = await newPage(browser, {}, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  const code = await createRoom(A.page);
  await room(A.page, (r) => r.link.client.setOptions({ difficulty: 'hard' }));
  const ola = await new Mate(baseURL!, code, 'Ola', PLAYER_COLOURS[2]).join();
  const siv = await new Mate(baseURL!, code, 'Siv', PLAYER_COLOURS[5]).join();
  await expect.poll(() => ola.client.options?.difficulty).toBe('hard');
  await startRun(A.page);
  await ola.inRun();
  await siv.inRun();
  const pidA = (await room(A.page, (r) => r.pid))!;
  const world = ola.client.world!;
  const posOf = (s: GameState, pid: string) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!.pos;
  const hostiles = (s: GameState) => s.area.actors.filter((a) => a.hp > 0 && a.faction === 'hostile');

  // --- the teammates walk away from the nearest hostile, then stay in a menu (busy: never a target) ---
  const s0 = ola.state!;
  const me0 = posOf(s0, pidA);
  const foe0 = hostiles(s0).sort((a, b) => Math.hypot(a.pos.x - me0.x, a.pos.y - me0.y) - Math.hypot(b.pos.x - me0.x, b.pos.y - me0.y))[0];
  expect(foe0, 'a hostile in the first area').toBeTruthy();
  await Promise.all([ola.walkAwayFrom(() => foe0.pos, { steps: 14 }), siv.walkAwayFrom(() => foe0.pos, { steps: 14 })]);
  ola.client.presence('menu');
  siv.client.presence('menu');

  // --- the page's player walks next to the hostile and waits there until it is down ---
  const down = () => room(A.page, (r, pid) => !!r.state()!.players[pid].down, pidA);
  let stuck = false;
  while (!(await down())) {
    expect(Date.now() - started, 'down within the bound').toBeLessThan(90_000);
    const s = ola.state!;
    if (s.status !== 'playing') break;
    const me = posOf(s, pidA);
    const foe = hostiles(s).sort((a, b) => Math.max(Math.abs(a.pos.x - me.x), Math.abs(a.pos.y - me.y)) - Math.max(Math.abs(b.pos.x - me.x), Math.abs(b.pos.y - me.y)))[0];
    const far = foe ? Math.max(Math.abs(foe.pos.x - me.x), Math.abs(foe.pos.y - me.y)) : 0;
    // (a step that made no entry, e.g. held by a lasso: wait instead)
    const dir = foe && far > 1 && !stuck ? stepToward(s, world, me, foe.pos) : null;
    const n = ola.client.n;
    // (a key press goes through the page's own UI → protocol path)
    await A.page.evaluate((a) => window.__anyworld!.controller!.actNow(a), dir ? { type: 'move' as const, dir } : { type: 'wait' as const });
    // (no entry: the step was refused, or a card or a choice holds the keys; answer it and go on)
    stuck = !(await expect.poll(() => ola.client.n > n, { timeout: 2_000 }).toBe(true).then(() => true, () => false));
    for (let i = 0; i < 4 && !(await down()); i++) {
      const l = await layer(A.page);
      if (l === 'game') break;
      await A.page.keyboard.press(l === 'choice' || l === 'levelup' ? '1' : 'Escape');
      await A.page.waitForTimeout(150);
    }
  }
  expect(await down()).toBe(true);

  // --- down: the banner, the camera on the nearest standing teammate, `]` to the other one ---
  const banner = A.page.locator('.aw-slot-banner .aw-party-banner[data-kind="down"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('You are down');
  await expect(banner.locator('.aw-spectate-name')).toContainText(/Watching (Ola|Siv)/);
  const followed = () => room(A.page, (r) => r.session!.followed);
  const f1 = await followed();
  expect([ola.pid, siv.pid]).toContain(f1);
  const actorOf = (pid: string) => ola.state!.players[pid].actorId;
  await expect.poll(async () => (await rings(A.page))[actorOf(f1!)]?.isPlayer).toBe(true);
  expect((await rings(A.page))[actorOf(pidA)].isPlayer).toBe(false);
  await expect(A.page.locator('.aw-ui[data-room-down]')).toHaveCount(1);
  await A.page.screenshot({ path: `${OUT}/party-spectator-desktop.png` });
  await A.page.keyboard.press(']');
  await expect.poll(followed).not.toBe(f1);
  await expect.poll(async () => (await rings(A.page))[actorOf((await followed())!)]?.isPlayer).toBe(true);

  // --- the teammates wait out the self-revive turns: A gets up, the camera comes back ---
  for (let i = 0; i < 30 && (await down()); i++) await Promise.all([ola.act({ type: 'wait' }), siv.act({ type: 'wait' })]);
  expect(await down()).toBe(false);
  await expect.poll(followed).toBeNull();
  await expect(banner).toBeHidden();
  await expect.poll(async () => (await rings(A.page))[actorOf(pidA)]?.isPlayer).toBe(true);
  expect(Date.now() - started).toBeLessThan(90_000 + 30_000);

  expect(A.errors).toEqual([]);
  ola.leave();
  siv.leave();
  await A.ctx.close();
});
