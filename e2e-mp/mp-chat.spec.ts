/**
 * MP3 D4: the room chat in real browsers (playwright.mp.config.ts), one page plus scripted
 * teammates (mates.ts) to save browsers. Desktop: the chat in the lobby, Enter opens the input in the
 * game and the keys typed there never move the player, a line sent reaches the teammates, the "…"
 * typing bubble and the speech bubble over a teammate on screen, a teammate off screen goes to the
 * column (highlighted) with an edge arrow instead, emotes and a "Follow me" ping, "Wait a moment" on
 * a send within the second (under the input and on the emote row), the 200-code-point stop, `/`
 * during a dialogue keeps the dialogue open, Esc in the chat leaves the backpack open. Phone
 * (390×844): the chat button in the tools row, the sheet with history, input, emotes and pings, an
 * overlap check with the sheet open and with the keyboard up.
 * Screenshots go to test-results/shots/MP3.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { createRoom, layer, Mate, myPlayer, newPage, PHONE, room, room as handle, startRun, toGameLayer } from './mates';

const OUT = 'test-results/shots/MP3';
mkdirSync(OUT, { recursive: true });


/** lines the mate has received */
const heard = (m: Mate) => m.client.chat.map((l) => (l.ping ? `ping:${l.ping.kind}` : l.text));

test.describe.configure({ mode: 'serial' });

test('desktop: lobby chat, Enter, keys stay in the input, bubbles and typing, off-screen column, emotes, pings, rate, 200 code points', async ({ browser, baseURL }) => {
  test.setTimeout(200_000);
  const A = await newPage(browser, {}, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  const code = await createRoom(A.page);
  const ola = await new Mate(baseURL!, code, 'Ola', PLAYER_COLOURS[2]).join();
  const siv = await new Mate(baseURL!, code, 'Siv', PLAYER_COLOURS[5]).join();

  // --- the lobby has the chat too ---
  const lobbyChat = A.page.locator('.aw-lobby-chat .aw-chat');
  await expect(lobbyChat).toBeVisible();
  ola.client.say('hei fra lobbyen');
  await expect(lobbyChat.locator('.aw-chat-line', { hasText: 'hei fra lobbyen' })).toBeVisible();
  // (the speaker is not on a map: the line is highlighted)
  await expect(lobbyChat.locator('.aw-chat-line.is-new', { hasText: 'hei fra lobbyen' })).toBeVisible();
  await A.page.locator('.aw-lobby-chat .aw-chat-input').fill('ready when you are');
  await A.page.locator('.aw-lobby-chat .aw-chat-input').press('Enter');
  await expect.poll(() => heard(ola)).toContain('ready when you are');
  await A.page.screenshot({ path: `${OUT}/chat-lobby-desktop.png` });

  await startRun(A.page);
  await ola.inRun();
  await siv.inRun();
  // three chips in the strip, and the dock on the right
  await expect(A.page.locator('.aw-strip .aw-party-chip')).toHaveCount(3);
  const dock = A.page.locator('.aw-slot-side .aw-chat[data-mode="dock"]');
  await expect(dock).toBeVisible();

  // --- Enter opens the input; WASD and digits typed there are text (no move, nothing sent) ---
  const before = await myPlayer(A.page);
  await A.page.keyboard.press('Enter');
  const input = dock.locator('.aw-chat-input');
  await expect(input).toBeFocused();
  expect(await handle(A.page, (r) => r.link.presence)).toBe('menu');
  await A.page.keyboard.type('wasd 123 on my way');
  await A.page.waitForTimeout(300);
  const after = await myPlayer(A.page);
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  expect(await handle(A.page, (r) => r.session?.queued ?? null)).toBeNull();
  // the teammates see "…" while A types
  await expect.poll(() => [...ola.client.typingSeats]).toContain(await handle(A.page, (r) => r.seat));
  await A.page.keyboard.press('Enter');
  await expect.poll(() => heard(ola)).toContain('wasd 123 on my way');
  await expect(input).toBeHidden();
  expect(await layer(A.page)).toBe('game');
  expect(await handle(A.page, (r) => r.link.presence)).toBe('playing');
  await expect(dock.locator('.aw-chat-line.is-own', { hasText: 'on my way' })).toBeVisible();

  // --- a teammate next to A (the party starts together): "…" then the speech bubble over them ---
  const olaSeat = ola.seat!;
  await expect.poll(() => handle(A.page, (r, seat) => r.onScreen(seat), olaSeat), { timeout: 10_000 }).toBe(true);
  ola.client.typing(true);
  await expect.poll(() => handle(A.page, (r) => r.bubbles()), { timeout: 10_000 }).toContainEqual({ seat: olaSeat, text: '…', kind: 'typing' });
  await expect(A.page.locator('.aw-party-overlay .aw-bubble.is-typing')).toBeVisible();
  ola.client.say('look at this');
  await expect.poll(() => handle(A.page, (r) => r.bubbles()), { timeout: 10_000 }).toContainEqual({ seat: olaSeat, text: 'look at this', kind: 'bubble' });
  await expect(A.page.locator('.aw-party-overlay .aw-name-tag', { hasText: 'Ola' })).toBeVisible();
  // (and Siv's line too: neither bubble hides a name tag)
  siv.client.say('and who are you?');
  await expect.poll(() => handle(A.page, (r) => r.bubbles().length), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(await coveredTags(A.page)).toEqual([]);
  // (on screen: not highlighted in the column)
  await expect(dock.locator('.aw-chat-line', { hasText: 'look at this' })).not.toHaveClass(/is-new/);
  await A.page.screenshot({ path: `${OUT}/chat-bubble-desktop.png` });

  // --- Siv walks off screen (the camera zoomed in): her line goes to the column, an edge arrow points at her ---
  for (let i = 0; i < 4; i++) await A.page.keyboard.press('+');
  const sivSeat = siv.seat!;
  await siv.walkAwayFrom(() => myPlayer(A.page), { steps: 40, done: () => handle(A.page, (r, seat) => !r.onScreen(seat), sivSeat) });
  await expect.poll(() => handle(A.page, (r, seat) => r.onScreen(seat), sivSeat), { timeout: 10_000 }).toBe(false);
  siv.client.say('over here');
  await expect(dock.locator('.aw-chat-line.is-new', { hasText: 'over here' })).toBeVisible();
  expect((await handle(A.page, (r) => r.bubbles())).some((b) => b.seat === sivSeat)).toBe(false);
  // (out of sight: an edge arrow, or a faint tag where she stands when that is inside the view)
  await expect(A.page.locator('.aw-party-overlay :is(.aw-edge-arrow, .aw-name-tag.is-fogged)', { hasText: 'Siv' })).toBeVisible();
  await A.page.screenshot({ path: `${OUT}/chat-offscreen-desktop.png` });
  for (let i = 0; i < 4; i++) await A.page.keyboard.press('-');

  // --- emotes and a ping (one shared 1/s bucket: the second within the second says "Wait a moment") ---
  // (an emote sent closes the dock as a line does: presence back to playing, the keys are the game's, MP5)
  await A.page.keyboard.press('Enter');
  await expect(dock.locator('.aw-chat-emotes')).toBeVisible();
  await dock.locator('[data-emote="👍"]').click();
  await expect(input).toBeHidden();
  expect(await handle(A.page, (r) => r.link.presence)).toBe('playing');
  await A.page.keyboard.press('Enter');
  await dock.locator('[data-emote="😂"]').click();
  await expect(dock.locator('.aw-chat-quick .aw-chat-slow')).toBeVisible();
  await expect(dock.locator('.aw-chat-form ~ .aw-chat-slow')).toBeVisible();
  // (refused: the dock stays open with the focus back in the input)
  await expect(input).toBeFocused();
  await expect.poll(() => heard(ola)).toContain('👍');
  expect(heard(ola)).not.toContain('😂');
  await A.page.waitForTimeout(1100);
  await dock.locator('[data-ping="follow"]').click();
  await expect.poll(() => heard(ola)).toContain('ping:follow');
  await expect(input).toBeHidden();
  expect(await handle(A.page, (r) => r.link.presence)).toBe('playing');
  await expect(A.page.locator('.aw-party-overlay .aw-ping[data-kind="follow"]')).toBeVisible();
  await expect(dock.locator('.aw-chat-line.is-ping')).toContainText('Follow me');
  // Esc with the focus on an emote button closes the dock too
  await A.page.keyboard.press('Enter');
  await dock.locator('[data-emote="👋"]').focus();
  await A.page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  expect(await handle(A.page, (r) => r.link.presence)).toBe('playing');
  // a typed line within the second keeps its draft
  await A.page.waitForTimeout(1100);
  await A.page.keyboard.press('Enter');
  await input.fill('first');
  await input.press('Enter');
  await A.page.keyboard.press('Enter');
  await input.fill('too soon');
  await input.press('Enter');
  await expect(dock.locator('.aw-chat-form ~ .aw-chat-slow')).toBeVisible();
  await expect(input).toHaveValue('too soon');
  await A.page.screenshot({ path: `${OUT}/chat-emotes-desktop.png` });

  // --- the field stops at 200 code points (❤️ is two), the counter shows from 160 ---
  await input.fill('x'.repeat(150));
  await expect(dock.locator('.aw-chat-counter')).toBeHidden();
  await input.fill('❤️'.repeat(120));
  await expect.poll(() => input.evaluate((el: HTMLInputElement) => Array.from(el.value).length)).toBe(200);
  await expect(dock.locator('.aw-chat-counter')).toHaveText('0 left');
  await input.press('Escape');
  await expect(input).toBeHidden();
  expect(await layer(A.page)).toBe('game');

  // --- a reload: the dock's history opens at the newest line, not the lobby's first one (MP5) ---
  for (let i = 0; i < 6; i++) {
    ola.client.say(`line ${i} ${'and some more words to fill the column '.repeat(2)}`);
    await A.page.waitForTimeout(1050);
  }
  ola.client.say('the newest line');
  await expect(dock.locator('.aw-chat-line', { hasText: 'the newest line' })).toBeAttached();
  await A.page.reload();
  await expect.poll(() => handle(A.page, (r) => r?.status ?? null), { timeout: 30_000 }).toBe('joined');
  await expect.poll(() => layer(A.page), { timeout: 60_000 }).toBe('game');
  const list = A.page.locator('.aw-slot-side .aw-chat[data-mode="dock"] .aw-chat-list');
  await expect(list.locator('.aw-chat-line', { hasText: 'the newest line' })).toBeAttached();
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(24);

  expect(A.errors).toEqual([]);
  ola.leave();
  siv.leave();
  await A.ctx.close();
});

test('desktop: `/` during a dialogue keeps it open; Esc in the chat leaves the backpack open', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const A = await newPage(browser, {}, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  const code = await createRoom(A.page);
  const ola = await new Mate(baseURL!, code, 'Ola', PLAYER_COLOURS[2]).join();
  await startRun(A.page);
  await ola.inRun();
  // Ola stays in a menu: busy, so the turns never wait on her and nothing picks her as a target
  ola.client.presence('menu');

  // --- walk to the nearest NPC and talk (click-to-travel, then t) ---
  const target = await A.page.evaluate(() => {
    const s = window.__anyworld!.controller!.session.state;
    const me = s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;
    const npcs = s.area.actors.filter((a) => a.hp > 0 && a.faction !== 'hostile' && a.faction !== 'player' && !a.allyOf);
    npcs.sort((a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.y - me.pos.y) - Math.hypot(b.pos.x - me.pos.x, b.pos.y - me.pos.y));
    return npcs[0] ? { id: npcs[0].id, pos: npcs[0].pos } : null;
  });
  expect(target).not.toBeNull();
  await expect
    .poll(
      async () => {
        const l = await layer(A.page);
        if (l === 'dialogue') return l;
        if (l !== 'game') await A.page.keyboard.press('Escape');
        const canTalk = await A.page.evaluate((id) => window.__anyworld!.controller!.session.viewModel().game?.actions?.some((a) => a.id === 'talk') ?? false, target!.id);
        if (canTalk) await A.page.keyboard.press('t');
        else await A.page.evaluate((p) => window.__anyworld!.controller!.onIntent({ type: 'click_tile', pos: p, button: 'primary' }), target!.pos);
        return l;
      },
      { timeout: 60_000, intervals: [1500] },
    )
    .toBe('dialogue');
  await expect(A.page.locator('.aw-dialogue')).toBeVisible();

  // --- `/` opens the chat over the dialogue; digits typed are text (no reply picked); the dialogue stays ---
  await A.page.keyboard.press('/');
  const input = A.page.locator('.aw-slot-side .aw-chat-input');
  await expect(input).toBeFocused();
  await A.page.keyboard.type('1 2 brb, talking');
  await A.page.keyboard.press('Enter');
  await expect.poll(() => ola.client.chat.map((l) => l.text)).toContain('1 2 brb, talking');
  expect(await layer(A.page)).toBe('dialogue');
  await expect(A.page.locator('.aw-dialogue')).toBeVisible();
  // the seat stays busy (the dialogue's safety is not ended by the chat)
  expect(await room(A.page, (r) => r.session!.state.players[r.pid!].pendingChoice?.kind ?? null)).toBe('dialogue');
  await A.page.screenshot({ path: `${OUT}/chat-dialogue-desktop.png` });
  await A.page.keyboard.press('Escape');
  await expect.poll(() => layer(A.page), { timeout: 10_000 }).toBe('game');

  // --- the backpack open, `/`, then Esc closes only the chat ---
  await A.page.keyboard.press('i');
  await expect.poll(() => layer(A.page)).toBe('backpack');
  await A.page.keyboard.press('/');
  await expect(input).toBeFocused();
  await A.page.keyboard.type('hold on');
  await A.page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  expect(await layer(A.page)).toBe('backpack');
  await expect(A.page.locator('.aw-backpack')).toBeVisible();
  await A.page.keyboard.press('Escape');
  await expect.poll(() => layer(A.page)).toBe('game');

  expect(A.errors).toEqual([]);
  ola.leave();
  await A.ctx.close();
});

/** visible actors (the own player included) whose every probe point is under a page element */
async function hiddenActors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const st = app.controller!.session.state;
    const r = app.renderer!;
    const w = st.area.map.width;
    const seen = st.players[st.party[0]].seen as ArrayLike<number>;
    const hidden: string[] = [];
    for (const a of st.area.actors) {
      if (a.hp <= 0 || seen[a.pos.y * w + a.pos.x] !== 2) continue;
      const pts = [r.actorScreen(a.id, 0.45), r.tileToScreen(a.pos)].filter(Boolean) as { x: number; y: number }[];
      const on = pts.filter((p) => p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight);
      if (!on.length) continue;
      const covers = on.map((p) => document.elementFromPoint(p.x, p.y)).filter((el) => !!el && !el.closest('#game-canvas'));
      if (covers.length === on.length) hidden.push(`${a.faction}:${a.id} under ${String((covers[0] as HTMLElement).className).split(' ')[0]}`);
    }
    return hidden;
  });
}

/** name tags (not faded) under another speaker's bubble on screen (MP5: a tag moves under the feet, or fades) */
const coveredTags = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const who = (el: Element) => (el as HTMLElement).style.getPropertyValue('--who');
    const bubbles = Array.from(document.querySelectorAll('.aw-party-overlay .aw-bubble:not(.aw-bubble-npc)'));
    return Array.from(document.querySelectorAll('.aw-party-overlay .aw-name-tag:not(.is-covered):not(.is-fogged)'))
      .filter((t) => {
        const a = box(t);
        return bubbles.some((b) => {
          const c = box(b);
          return who(b) !== who(t) && a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top;
        });
      })
      .map((t) => t.textContent ?? '');
  });

const rect = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);

test('phone 390×844: chat button and sheet, emotes and pings, ticker and unread, overlap with the sheet and the keyboard up', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const P = await newPage(browser, PHONE, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  const code = await createRoom(P.page);
  const ola = await new Mate(baseURL!, code, 'Ola', PLAYER_COLOURS[2]).join();
  await startRun(P.page);
  await ola.inRun();

  // --- the strip: a dot per member, no turn counter; the chat button in the tools row ---
  await expect(P.page.locator('.aw-strip .aw-party-chip')).toHaveCount(2);
  await expect(P.page.locator('.aw-strip .aw-party-name').first()).toBeHidden();
  await expect(P.page.locator('.aw-strip-turn')).toBeHidden();
  const button = P.page.locator('.aw-hotbar-tools .aw-chat-button');
  await expect(button).toBeVisible();
  expect(await P.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // --- lines while the sheet is closed: a bubble over Ola on screen; out of sight, over the log ticker; the unread badge ---
  ola.client.say('hi');
  await expect.poll(() => room(P.page, (r) => r.bubbles().map((b) => b.text))).toContain('hi');
  await expect(button.locator('.aw-chat-badge')).toHaveText('1');
  const olaSeat = ola.seat!;
  await ola.walkAwayFrom(() => myPlayer(P.page), { steps: 40, done: () => room(P.page, (r, seat) => !r.onScreen(seat), olaSeat) });
  await expect.poll(() => room(P.page, (r, seat) => r.onScreen(seat), olaSeat), { timeout: 10_000 }).toBe(false);
  ola.client.say('where are you?');
  await expect(P.page.locator('.aw-log .aw-log-chat')).toContainText('Ola: where are you?');
  await expect(button.locator('.aw-chat-badge')).toHaveText('2');
  await P.page.screenshot({ path: `${OUT}/chat-ticker-phone.png` });

  // --- the sheet: history, input, emotes, pings; presence menu while open ---
  await button.tap();
  const sheet = P.page.locator('.aw-chat-sheet');
  await expect(sheet).toBeVisible();
  await expect(button.locator('.aw-chat-badge')).toBeHidden();
  await expect(sheet.locator('.aw-chat-line', { hasText: 'where are you?' })).toBeVisible();
  // (it opens at the newest line, MP5)
  await expect.poll(() => sheet.locator('.aw-chat-list').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(24);
  expect(await room(P.page, (r) => r.link.presence)).toBe('menu');
  await sheet.locator('[data-emote="👋"]').tap();
  await expect.poll(() => ola.client.chat.map((l) => l.text)).toContain('👋');
  await P.page.waitForTimeout(1100);
  await sheet.locator('[data-ping="help"]').tap();
  await expect.poll(() => ola.client.chat.some((l) => l.ping?.kind === 'help')).toBe(true);
  await expect(P.page.locator('.aw-party-overlay .aw-ping[data-kind="help"]')).toBeVisible();

  // --- overlap: the sheet is inside the screen, counted as a panel, and no visible actor is under it ---
  const vh = 844;
  let r = await rect(P.page, '.aw-chat-sheet');
  expect(r.top).toBeGreaterThan(vh * 0.4);
  expect(r.bottom).toBeLessThanOrEqual(vh + 1);
  expect(r.left).toBeGreaterThanOrEqual(0);
  expect(r.right).toBeLessThanOrEqual(390);
  expect(await P.page.evaluate(() => window.__anyworld!.ui.panelRects().hud.some((x) => x.height > 100 && x.bottom >= innerHeight - 2))).toBe(true);
  await expect.poll(() => hiddenActors(P.page), { timeout: 15_000 }).toEqual([]);
  expect(await P.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await P.page.screenshot({ path: `${OUT}/chat-sheet-phone.png` });

  // --- the keyboard up (the layout viewport shrinks: interactive-widget=resizes-content) ---
  await sheet.locator('.aw-chat-input').tap();
  await P.page.setViewportSize({ width: 390, height: 470 });
  await P.page.waitForTimeout(400);
  r = await rect(P.page, '.aw-chat-sheet');
  const inp = await rect(P.page, '.aw-chat-sheet .aw-chat-input');
  expect(r.top).toBeGreaterThanOrEqual(0);
  expect(inp.bottom).toBeLessThanOrEqual(470);
  expect(inp.top).toBeGreaterThanOrEqual(0);
  await P.page.keyboard.type('on my way');
  await P.page.keyboard.press('Enter');
  await expect.poll(() => ola.client.chat.map((l) => l.text)).toContain('on my way');
  // (the sheet stays open after a line)
  await expect(sheet).toBeVisible();
  await expect.poll(() => hiddenActors(P.page), { timeout: 15_000 }).toEqual([]);
  await P.page.screenshot({ path: `${OUT}/chat-keyboard-phone.png` });
  await P.page.setViewportSize({ width: 390, height: 844 });

  // --- closed with ✕: presence back to playing ---
  await sheet.locator('.aw-chat-close').tap();
  await expect(sheet).toBeHidden();
  expect(await room(P.page, (r) => r.link.presence)).toBe('playing');

  expect(P.errors).toEqual([]);
  ola.leave();
  await P.ctx.close();
});
