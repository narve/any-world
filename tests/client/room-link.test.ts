/**
 * RoomLink (MP3 D3): presence on change only (menus and a hidden tab), seat tokens kept per code,
 * the "You are Kari 2" rename, a bad token joining as new, another tab ending the link, leaving,
 * and the WorldEntry adapter, against a real room through the in-memory harness.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemRoom, ENGINE } from './room-harness';
import { RoomLink, roomWorldEntry, type LinkEvent, type VisibilityDoc } from '../../src/client/room/link';
import { seatToken, saveSeat, type KeyValueStore } from '../../src/client/room/profile';
import type { ClientMsg } from '../../src/net/protocol';
import type { WorldSpec } from '../../src/schema/world';

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

class FakeDoc implements VisibilityDoc {
  hidden = false;
  private fns = new Set<() => void>();
  addEventListener(_t: 'visibilitychange', fn: () => void): void {
    this.fns.add(fn);
  }
  removeEventListener(_t: 'visibilitychange', fn: () => void): void {
    this.fns.delete(fn);
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const fn of this.fns) fn();
  }
}

let rooms: MemRoom[] = [];
afterEach(() => {
  for (const r of rooms) r.dispose();
  rooms = [];
});

function setup() {
  const room = new MemRoom();
  rooms.push(room);
  const store = memStore();
  const make = (name: string, o: { token?: string | null; colour?: '#e6194b' | '#3cb44b' | '#4363d8'; doc?: FakeDoc | null; code?: string } = {}) => {
    const sent: ClientMsg[] = [];
    const events: LinkEvent[] = [];
    const link = new RoomLink({
      code: o.code ?? room.code,
      url: 'mem://room',
      profile: { name, colour: o.colour ?? '#e6194b' },
      token: o.token ?? null,
      socket: room.socketFactory(sent),
      store,
      doc: o.doc ?? null,
      engine: ENGINE,
      ...room.timers(),
    });
    link.on((e) => events.push(e));
    return { link, sent, events };
  };
  return { room, store, make };
}

const presences = (sent: ClientMsg[]) => sent.filter((m) => m.t === 'presence').map((m) => (m as { state: string }).state);

describe('RoomLink', () => {
  it('keeps the seat token per code and sends presence on change only', async () => {
    const { room, store, make } = setup();
    const doc = new FakeDoc();
    const a = make('Kari', { token: room.hostToken, doc });
    a.link.connect();
    await room.flush();
    expect(a.link.client.status).toBe('joined');
    expect(seatToken(room.code, Date.now(), store)).toBe(room.hostToken);
    expect(a.events.some((e) => e.t === 'welcome' && e.first && !e.renamed)).toBe(true);
    // a joined seat starts as playing: nothing to say yet
    expect(presences(a.sent)).toEqual([]);
    a.link.setMenu('panel:backpack', true);
    a.link.setMenu('settings', true);
    a.link.setMenu('panel:backpack', false);
    expect(presences(a.sent)).toEqual(['menu']);
    a.link.setMenu('settings', false);
    expect(presences(a.sent)).toEqual(['menu', 'playing']);
    doc.set(true);
    doc.set(true);
    doc.set(false);
    expect(presences(a.sent)).toEqual(['menu', 'playing', 'menu', 'playing']);
  });

  it('says so when the server gave another name and colour (a clash)', async () => {
    const { room, make } = setup();
    const a = make('Kari', { token: room.hostToken });
    a.link.connect();
    await room.flush();
    const b = make('Kari', { colour: '#e6194b' });
    b.link.connect();
    await room.flush();
    const w = b.events.find((e): e is Extract<LinkEvent, { t: 'welcome' }> => e.t === 'welcome');
    expect(w?.renamed?.name).toBe('Kari 2');
    expect(w?.renamed?.colour).not.toBe('#e6194b');
    // a reconnect does not say it again
    b.link.client.drop();
    await room.advance(600);
    expect(b.link.client.status).toBe('joined');
    expect(b.events.filter((e) => e.t === 'welcome' && e.renamed).length).toBe(1);
  });

  it('a bad token drops the seat and joins as new', async () => {
    const { room, store, make } = setup();
    const bogus = 'AAAAAAAAAAAAAAAAAAAAAA';
    saveSeat(room.code, bogus, Date.now(), store);
    const a = make('Kari', { token: bogus });
    a.link.connect();
    await room.flush();
    expect(a.events.some((e) => e.t === 'toast' && e.key === 'net.badToken')).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await room.flush();
    expect(a.link.client.status).toBe('joined');
    expect(a.link.closed).toBe(false);
    const stored = seatToken(room.code, Date.now(), store);
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(bogus);
  });

  it('another tab on the same seat ends this link with room.otherTab, keeping the seat', async () => {
    const { room, store, make } = setup();
    const a = make('Kari', { token: room.hostToken });
    a.link.connect();
    await room.flush();
    const b = make('Kari', { token: room.hostToken });
    b.link.connect();
    await room.flush();
    expect(a.events.find((e) => e.t === 'end')).toEqual({ t: 'end', key: 'room.otherTab' });
    expect(a.link.closed).toBe(true);
    expect(b.link.client.status).toBe('joined');
    expect(seatToken(room.code, Date.now(), store)).toBe(room.hostToken);
  });

  it('a room that does not exist ends with net.noRoom and leaves no seat', async () => {
    const { room, store, make } = setup();
    const a = make('Kari', { code: 'ZZZZ' });
    a.link.connect();
    await room.flush();
    expect(a.events.find((e) => e.t === 'end')).toEqual({ t: 'end', key: 'net.noRoom' });
    expect(seatToken('ZZZZ', Date.now(), store)).toBeNull();
  });

  it('leave gives the seat up (the server marks it, this page forgets it)', async () => {
    const { room, store, make } = setup();
    const a = make('Kari', { token: room.hostToken });
    a.link.connect();
    await room.flush();
    a.link.leave();
    await room.flush();
    expect(a.sent.some((m) => m.t === 'leave')).toBe(true);
    expect(a.link.closed).toBe(true);
    expect(seatToken(room.code, Date.now(), store)).toBeNull();
    expect(a.events.some((e) => e.t === 'end')).toBe(false);
  });

  it('chat frames reach the ChatModel; a welcome merges the history quietly', async () => {
    const { room, make } = setup();
    const a = make('Kari', { token: room.hostToken });
    a.link.connect();
    await room.flush();
    const b = make('Ola', { colour: '#3cb44b' });
    b.link.connect();
    await room.flush();
    a.link.client.say('hello');
    await room.flush();
    expect(b.link.chat.lines.map((l) => l.text)).toEqual(['hello']);
    expect(b.link.chat.unread).toBe(1);
    b.link.client.drop();
    await room.advance(600);
    expect(b.link.chat.lines.length).toBe(1);
    expect(b.link.chat.unread).toBe(1);
  });
});

describe('roomWorldEntry', () => {
  it('names the bundled demo a room world came from (matched by title and language)', () => {
    const world = { meta: { title: 'Dust Town', language: 'en' } } as unknown as WorldSpec;
    const demos = [
      { id: 'other', meta: { title: 'Dust Town', language: 'nb', tagline: '', genre: '', tags: [], tone: '', premise: '', prompt: '' } },
      { id: 'fixture-western', meta: { title: 'Dust Town', language: 'en', tagline: '', genre: '', tags: [], tone: '', premise: '', prompt: '' } },
    ];
    expect(roomWorldEntry(world, 'w123', demos)).toEqual({ id: 'w123', world, origin: 'fixture-western' });
    expect(roomWorldEntry(world, 'w123', [])).toEqual({ id: 'w123', world });
  });
});
