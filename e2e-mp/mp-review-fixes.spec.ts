/**
 * MP3 review fixes in real browsers (playwright.mp.config.ts), one page plus a scripted teammate:
 *  - a chat line the server drops (it arrived within a second of the one before, which the network
 *    held back) comes back into the input with "Wait a moment", instead of being lost;
 *  - an open desktop chat input that moves to the phone sheet (a resize) ends presence `menu`;
 *  - after a run is won or lost the page's room phase is `ended`: an input that crossed the end on the
 *    wire does not toast, and the host's "Choose another world" lobby says Finished / Play again and
 *    goes back to the end screen when the picker closes;
 *  - leaving the room clears the seat ring colours, so a single-player run on the same page has its own;
 *  - phones: toasts move to the top while the room chat sheet is open.
 */
import { test, expect } from '@playwright/test';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { createRoom, Mate, newPage, PHONE, ready, room, screen, startRun } from './mates';

test.describe.configure({ mode: 'serial' });

const heard = (m: Mate) => m.client.chat.map((l) => l.text);

test('desktop: a dropped chat line comes back, the dock leaving ends menu, the end of a run, ring colours after leaving', async ({ browser, baseURL }) => {
  test.setTimeout(420_000);
  const A = await newPage(browser, {}, { name: 'Kari', colour: PLAYER_COLOURS[0] });
  // the network holds the first chat frame back by 300 ms (ordinary phone-network jitter)
  await A.ctx.addInitScript(() => {
    const send = WebSocket.prototype.send;
    let held = false;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (!held && typeof data === 'string' && data.includes('"t":"chat"')) {
        held = true;
        setTimeout(() => send.call(this, data), 300);
        return;
      }
      send.call(this, data);
    };
  });
  const code = await createRoom(A.page);
  const ola = await new Mate(baseURL!, code, 'Ola', PLAYER_COLOURS[2]).join();

  // --- the second line arrives within the second of the first: it is dropped and given back ---
  const input = A.page.locator('.aw-lobby-chat .aw-chat-input');
  await input.fill('first line');
  await input.press('Enter');
  await A.page.waitForTimeout(1050);
  await input.fill('second line');
  await input.press('Enter');
  await expect.poll(() => heard(ola)).toContain('first line');
  await expect(input).toHaveValue('second line');
  await expect(A.page.locator('.aw-lobby-chat .aw-chat-form ~ .aw-chat-slow')).toBeVisible();
  expect(heard(ola)).not.toContain('second line');
  await A.page.waitForTimeout(1100);
  await input.press('Enter');
  await expect.poll(() => heard(ola)).toContain('second line');
  await expect(input).toHaveValue('');

  // --- the dock's open input moves to the phone sheet (a resize): presence is playing again ---
  await startRun(A.page);
  await ola.inRun();
  await A.page.keyboard.press('Enter');
  await A.page.keyboard.type('hi');
  expect(await room(A.page, (r) => r.link.presence)).toBe('menu');
  await A.page.setViewportSize({ width: 600, height: 844 });
  await expect.poll(() => room(A.page, (r) => r.link.presence)).toBe('playing');
  const seat = await room(A.page, (r) => r.seat);
  await expect.poll(() => ola.client.roster.find((s) => s.seat === seat)?.presence).toBe('active');
  await A.page.setViewportSize({ width: 1280, height: 800 });

  // --- the run ends (the mate leaves, the autoplay plays it out): the phase is ended ---
  ola.leave();
  await room(A.page, (r) => r.autoplay(true, { bot: 'explorer', seed: 5, chatEvery: 0 }));
  // (the autoplay waits while its player is not ready, for teammates to move the world; alone, a
  // wait from the page does it, as a key press would)
  let lastN = -1;
  await expect
    .poll(
      async () => {
        const n = await room(A.page, (r) => r.n);
        if (n === lastN) await room(A.page, (r) => r.link.client.input([{ type: 'wait' }], 'wait'));
        lastN = n;
        return room(A.page, (r) => r.state()?.status ?? 'playing');
      },
      { timeout: 360_000, intervals: [1000] },
    )
    .not.toBe('playing');
  await room(A.page, (r) => r.autoplay(false));
  expect(await room(A.page, (r) => r.phase)).toBe('ended');
  // an input that crossed the end of the run on the wire: answered bad_phase, quietly
  await room(A.page, (r) => r.link.client.input([{ type: 'wait' }]));
  await A.page.waitForTimeout(800);
  await expect(A.page.locator('.aw-toast', { hasText: 'That is not possible right now.' })).toHaveCount(0);

  // --- "Choose another world": the lobby of a finished run, and back to the end screen ---
  await expect.poll(() => screen(A.page), { timeout: 20_000 }).toBe('end');
  await A.page.locator('.aw-end-another').click();
  await expect(A.page.locator('.aw-lobby')).toHaveAttribute('data-phase', 'ended');
  await expect(A.page.locator('.aw-lobby-start')).toHaveText('Play again');
  await A.page.locator('.aw-lobby-change-world').click();
  await expect.poll(() => screen(A.page)).toBe('end');

  // --- leaving the room: a single-player run on this page has no seat colours left ---
  const ringColours = () => A.page.evaluate(() => (window.__anyworld!.renderer as unknown as { partyColours: Map<string, string> }).partyColours.size);
  expect(await ringColours()).toBeGreaterThan(0);
  await A.page.evaluate(() => window.__anyworld!.leaveRoom());
  await expect(A.page.locator('.aw-start')).toBeVisible({ timeout: 20_000 });
  await A.page.locator('.aw-demo[data-world="fixture-western"]').first().click();
  await expect.poll(() => screen(A.page), { timeout: 60_000 }).toBe('game');
  expect(await ringColours()).toBe(0);
  expect(A.errors).toEqual([]);
  ola.stop();
  await A.ctx.close();
});

test('phone: toasts move to the top while the room chat sheet is open', async ({ browser }) => {
  test.setTimeout(120_000);
  const C = await newPage(browser, PHONE, { name: 'Siv', colour: PLAYER_COLOURS[5] });
  await createRoom(C.page);
  await startRun(C.page);
  await ready(C.page);
  await C.page.locator('.aw-chat-button').tap();
  const sheet = C.page.locator('.aw-chat-sheet');
  await expect(sheet).toBeVisible();
  await expect(C.page.locator('#ui-root')).toHaveAttribute('data-room-chat', '1');
  await C.page.evaluate(() => window.__anyworld!.ui.toast('A toast while chatting', 'warn'));
  const toast = C.page.locator('.aw-toast', { hasText: 'A toast while chatting' });
  await expect(toast).toBeVisible();
  const [t, s] = [await toast.boundingBox(), await sheet.boundingBox()];
  expect(t!.y + t!.height).toBeLessThanOrEqual(s!.y);
  await sheet.locator('.aw-chat-close').tap();
  await expect(sheet).toBeHidden();
  await expect(C.page.locator('#ui-root')).not.toHaveAttribute('data-room-chat', '1');
  expect(C.errors).toEqual([]);
  await C.ctx.close();
});
