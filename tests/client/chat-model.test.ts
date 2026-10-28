/**
 * MP3 D2: ChatModel (src/client/room/chat-model.ts): the 100-line cap, merge by id, one bubble per
 * speaker and its lifetime, emote detection, ping lines, the typing set and its expiry, the 1/s
 * throttle shared by text, emotes and pings, unread counts, and code-point counting that matches the
 * protocol's codePoints.
 */
import { describe, it, expect } from 'vitest';
import { bubbleMs, CHAT_TIMING, ChatModel, EMOTES, isEmote } from '../../src/client/room/chat-model';
import { codePoints, LIMITS, PLAYER_COLOURS, type ChatLine } from '../../src/net/protocol';

const line = (id: number, seat: string, text: string, extra: Partial<ChatLine> = {}): ChatLine => ({ id, seat, name: seat.toUpperCase(), colour: PLAYER_COLOURS[0], text, at: id * 10, ...extra });

describe('ChatModel', () => {
  it('keeps the last 100 lines in id order and merges a welcome by id', () => {
    const m = new ChatModel({ self: 's1' });
    for (let i = 1; i <= 120; i++) m.push(line(i, 's2', `l${i}`), 0);
    expect(m.lines).toHaveLength(LIMITS.chatHistory);
    expect(m.lines[0].id).toBe(21);
    expect(m.lines.at(-1)!.id).toBe(120);
    // a reconnect's welcome: the known lines are not added again, a missed one is added in order
    const added = m.merge([line(119, 's2', 'l119'), line(120, 's2', 'l120'), line(121, 's3', 'missed')]);
    expect(added).toBe(1);
    expect(m.lines.at(-1)!.text).toBe('missed');
    expect(m.push(line(121, 's3', 'missed'), 0)).toBe(false);
    // a late older line goes in by id
    const n = new ChatModel();
    n.push(line(5, 's2', 'b'), 0);
    n.push(line(3, 's2', 'a'), 0);
    expect(n.lines.map((l) => l.id)).toEqual([3, 5]);
  });

  it('gives one bubble per speaker, the newest line, for 4 s + 50 ms a character up to 10 s', () => {
    const m = new ChatModel({ self: 's1' });
    m.push(line(1, 's2', 'hi'), 1000);
    m.push(line(2, 's3', 'x'.repeat(200)), 1000);
    m.push(line(3, 's2', 'on my way'), 1500);
    const b = m.bubbles(1600);
    expect(b.map((x) => [x.seat, x.text])).toEqual([['s3', 'x'.repeat(200)], ['s2', 'on my way']]);
    expect(b.find((x) => x.seat === 's2')!.until).toBe(1500 + 4000 + 50 * 9);
    expect(b.find((x) => x.seat === 's3')!.until).toBe(1000 + 10_000);
    expect(m.bubbles(1500 + 4450).map((x) => x.seat)).toEqual(['s3']);
    expect(m.bubbles(11_000)).toEqual([]);
    // merged (catch-up) lines give no bubble
    m.merge([line(9, 's4', 'old news')]);
    expect(m.bubbles(11_000)).toEqual([]);
  });

  it('marks a line of exactly one emote, and pings with their own lifetime', () => {
    const m = new ChatModel();
    for (const e of EMOTES) expect(isEmote(e)).toBe(true);
    expect(isEmote('👍👍')).toBe(false);
    expect(isEmote('ok 👍')).toBe(false);
    m.push(line(1, 's2', '❤️'), 0);
    m.push(line(2, 's3', '', { ping: { kind: 'follow', x: 3, y: 4, area: 0 } }), 0);
    const [heart, ping] = m.bubbles(1);
    expect(heart.emote).toBe(true);
    expect(ping).toMatchObject({ ping: 'follow', emote: false, until: CHAT_TIMING.pingMs });
    expect(bubbleMs({ text: '' , ping: { kind: 'help', x: 0, y: 0, area: 0 } })).toBe(8000);
  });

  it('keeps who is typing until their next line or the expiry, never this client', () => {
    const m = new ChatModel({ self: 's1' });
    m.setTyping('s2', true, 0);
    m.setTyping('s3', true, 0);
    m.setTyping('s1', true, 0);
    expect([...m.typing(100)].sort()).toEqual(['s2', 's3']);
    m.push(line(1, 's2', 'done'), 200);
    expect([...m.typing(300)]).toEqual(['s3']);
    m.setTyping('s3', true, 5000);
    expect([...m.typing(8000)]).toEqual(['s3']);
    expect([...m.typing(5000 + CHAT_TIMING.typingMs)]).toEqual([]);
    m.setTyping('s4', true, 0);
    m.setTyping('s4', false, 1);
    expect(m.typing(2).has('s4')).toBe(false);
  });

  it('throttles sends to one a second, shared by text, emotes and pings', () => {
    const m = new ChatModel();
    expect(m.canSend(0)).toEqual({ ok: true });
    m.noteSent(1000); // a ping
    expect(m.canSend(1300)).toEqual({ ok: false, waitMs: 700 }); // an emote right after it
    expect(m.canSend(1999)).toEqual({ ok: false, waitMs: 1 });
    expect(m.canSend(2000)).toEqual({ ok: true });
  });

  it('counts unread lines from others while the sheet is closed', () => {
    const m = new ChatModel({ self: 's1' });
    m.push(line(1, 's2', 'a'), 0);
    m.push(line(2, 's1', 'mine'), 0);
    m.push(line(3, 's3', 'b'), 0);
    expect(m.unread).toBe(2);
    m.setSheetOpen(true);
    expect(m.unread).toBe(0);
    m.push(line(4, 's2', 'c'), 0);
    expect(m.unread).toBe(0);
    m.setSheetOpen(false);
    m.push(line(5, 's2', 'd'), 0);
    expect(m.unread).toBe(1);
  });

  it('counts the draft in code points as the protocol does (❤️ is two), with the counter from 160', () => {
    const m = new ChatModel();
    for (const t of ['hello', '❤️', '👍🏽', 'é', 'ﬁ', '𝔸b']) expect(m.draft(t).count).toBe(codePoints(t));
    expect(m.draft('❤️').count).toBe(2);
    expect(m.draft('x'.repeat(159)).counter).toBe(false);
    expect(m.draft('x'.repeat(160))).toEqual({ count: 160, left: 40, over: false, counter: true });
    expect(m.draft('❤️'.repeat(101))).toMatchObject({ count: 202, over: true, left: -2 });
  });
});
