/**
 * MP4 G4: the AI GM in a party room, in real browsers, on scripted mock answers (the config's second
 * server: ANYWORLD_TEST_GM = test-gm.json; no real provider). Two pages and a scripted teammate:
 *  - the new-world form has "For a party" (off); the lobby says the game master reads the chat
 *    (RoomInfo.gm 'ai');
 *  - the scripted intro card shows on both pages;
 *  - a line addressed to the GM gets its scripted answer in the chat panel (no card);
 *  - the teammate talks to an NPC next to Kari: Kari sees the NPC's line as a bubble over it, then
 *    the voiced line (the server's `npc` message) in its place; the teammate's replica has it too;
 *  - every page and the teammate on one hash.
 * Screenshots go to test-results/shots/MP4.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { bfsDistances, hashState, passability } from '../src/engine/index';
import type { GameState, Pos } from '../src/engine/types';
import type { WorldSpec } from '../src/schema/world';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { GM_PORT } from './playwright.mp.config';
import { createRoom, layer, Mate, newPage, ready, room, screen, toGameLayer } from './mates';

const OUT = 'test-results/shots/MP4';
mkdirSync(OUT, { recursive: true });
const BASE = `http://localhost:${GM_PORT}`;
const INTRO = 'SCRIPTED INTRO: the dust settles over Sweetwater.';
const CHAT = 'SCRIPTED CHAT: the game master hears you.';
const VOICE = 'SCRIPTED VOICE: welcome, stranger.';

test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

/** the page's own position and the friendly NPCs of its area, nearest first */
const around = (page: Page) =>
  page.evaluate(() => {
    const s = window.__anyworld!.controller!.session.state;
    const me = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
    const world = window.__anyworld!.controller!.session.world;
    const npcs = s.area.actors.filter((a) => a.hp > 0 && !a.allyOf && world.actors.find((d) => d.id === a.defId)?.npc && a.faction !== 'hostile');
    npcs.sort((a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.y - me.pos.y) - Math.hypot(b.pos.x - me.pos.x, b.pos.y - me.pos.y));
    return { me: me.pos, npcs: npcs.map((n) => ({ id: n.id, pos: n.pos })) };
  });

/** a floor tile 2–3 steps from `p` (BFS), for standing near an NPC without talking to it */
function nearTile(s: GameState, p: Pos, world: WorldSpec): Pos {
  const w = s.area.map.width;
  const d = bfsDistances(w, s.area.map.height, p, passability(s, { world }));
  for (const want of [2, 3, 1]) {
    const i = d.findIndex((x) => x === want);
    if (i >= 0) return { x: i % w, y: Math.floor(i / w) };
  }
  return p;
}

test('the AI GM in a party room: lobby line, intro card on both pages, chat answer in the panel, NPC bubble and voice, one hash', async ({ browser }) => {
  test.setTimeout(200_000);
  const A = await newPage(browser, { baseURL: BASE }, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  // ("For a party" in the new-world form: shown with a game server, off by default)
  await A.page.goto('/');
  await ready(A.page);
  await A.page.locator('.aw-byo-toggle').click();
  await expect(A.page.locator('.aw-start-party')).toBeVisible();
  await expect(A.page.locator('#aw-party')).not.toBeChecked();
  const code = await createRoom(A.page);
  await expect(A.page.locator('.aw-lobby-gm')).toBeVisible();
  await expect(A.page.locator('.aw-lobby-gm')).toContainText('game master');
  expect(await room(A.page, (r) => r.link.client.room?.gm)).toBe('ai');

  const B = await newPage(browser, { baseURL: BASE }, { name: 'Ola', colour: PLAYER_COLOURS[2] });
  await B.page.goto(`/?room=${code}`);
  await ready(B.page);
  await expect(B.page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  await expect(B.page.locator('.aw-lobby-gm')).toBeVisible();
  const siv = await new Mate(BASE, code, 'Siv', PLAYER_COLOURS[5]).join();

  // --- the scripted intro card on both pages ---
  await A.page.locator('.aw-lobby-start').click();
  for (const P of [A, B]) {
    await expect.poll(() => screen(P.page), { timeout: 60_000 }).toBe('game');
    await expect(P.page.locator('.aw-narration')).toContainText(INTRO, { timeout: 20_000 });
  }
  await siv.inRun();
  await A.page.screenshot({ path: `${OUT}/gm-intro-desktop.png` });
  for (const P of [A, B]) await toGameLayer(P.page);
  // (Ola reads a menu: the turns never wait on her)
  await room(B.page, (r) => r.link.setMenu('spec', true));

  // --- a line addressed to the GM: the answer is a chat line on both pages, not a card ---
  siv.client.say('@gm is anyone listening?');
  for (const P of [A, B]) await expect(P.page.locator('.aw-chat-line.is-gm', { hasText: CHAT })).toBeVisible({ timeout: 20_000 });
  expect(await layer(A.page)).toBe('game');
  await expect(A.page.locator('.aw-narration')).toBeHidden();

  // --- Kari walks near the nearest NPC (click-to-travel to a tile 2 steps off it), Siv talks to it ---
  const start = await around(A.page);
  expect(start.npcs.length).toBeGreaterThan(0);
  const npc = start.npcs[0]!;
  const spot = nearTile(siv.state!, npc.pos, siv.client.world!);
  await expect
    .poll(
      async () => {
        const now = await around(A.page);
        const d = Math.max(Math.abs(now.me.x - npc.pos.x), Math.abs(now.me.y - npc.pos.y));
        if (d > 3) {
          if ((await layer(A.page)) !== 'game') await A.page.keyboard.press('Escape');
          await A.page.evaluate((p) => window.__anyworld!.controller!.onIntent({ type: 'click_tile', pos: p, button: 'primary' }), spot);
        }
        return d;
      },
      { timeout: 60_000, intervals: [1500] },
    )
    .toBeLessThanOrEqual(3);
  await siv.walkTo(npc.pos, { steps: 80, near: 1 });
  const talking = () => siv.client.state?.players[siv.pid!]?.pendingChoice?.kind === 'dialogue';
  await expect
    .poll(
      () => {
        if (!talking()) siv.client.input([{ type: 'talk', targetId: npc.id }], 'decide');
        return talking();
      },
      { timeout: 30_000, intervals: [800] },
    )
    .toBe(true);
  // the canned line (or already the voice) over the NPC on Kari's page, then the voiced line
  await expect.poll(() => room(A.page, (r, id) => r.npcBubbles().find((b) => b.actorId === id)?.text ?? '', npc.id), { timeout: 20_000 }).toBe(VOICE);
  await expect(A.page.locator('.aw-party-overlay .aw-bubble-npc', { hasText: VOICE })).toBeVisible();
  await A.page.screenshot({ path: `${OUT}/gm-npc-bubble-desktop.png` });

  // --- every page and the teammate on one hash ---
  await room(B.page, (r) => r.link.setMenu('spec', false));
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([room(A.page, (r) => [r.n, r.hash()] as const), room(B.page, (r) => [r.n, r.hash()] as const)]);
      const mine = siv.client.state ? hashState(siv.client.state) : null;
      return a[0] === b[0] && a[0] === siv.client.n && a[1] === b[1] && a[1] === mine ? 'same' : `${a[0]} ${b[0]} ${siv.client.n}`;
    }, { timeout: 20_000 })
    .toBe('same');
  const gm = await room(A.page, (r) => r.state()!.log.filter((l) => l.kind === 'gm').map((l) => l.text));
  expect(gm).toContain(INTRO);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
  siv.stop();
  await A.ctx.close();
  await B.ctx.close();
});
