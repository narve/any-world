/**
 * MP2 C2: the room protocol (src/net/protocol.ts, design §2). Every message parses, bounds hold,
 * unknown or malformed messages are refused, frame and nesting limits, peekHello reads the engine
 * version of any hello leniently, and PlayerActionSchema is the engine's PlayerAction (type check).
 * MP3 D1: ready, profile, world, ping, the difficulty option, the room message, ready in the roster,
 * pings in chat lines, and pings sharing chat's rate.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  ClientMsg,
  CreateRoomRequest,
  LIMITS,
  LogEntrySchema,
  PLAYER_COLOURS,
  PlayerActionSchema,
  PROTOCOL,
  REFUSED_CLOSE,
  RefusedCode,
  ServerMsg,
  TurnInputSchema,
  cleanChat,
  cleanText,
  codePoints,
  parseClientMsg,
  parseServerMsg,
  peekHello,
  type SameType,
} from '../../src/net/protocol';
import type { PlayerAction, TurnInput } from '../../src/engine/types';
import { TOTAL_SLOTS } from '../../src/engine';

// the two-way type check (protocol.ts holds the same one, so the build breaks on a new engine action)
const actionsMatch: SameType<z.infer<typeof PlayerActionSchema>, PlayerAction> = true;
const inputsMatch: SameType<z.infer<typeof TurnInputSchema>, TurnInput> = true;
// @ts-expect-error SameType is strict: an optional field on one side only is a difference
const optionalDiffers: SameType<{ a: number }, { a: number; b?: string }> = true;
// @ts-expect-error a missing union member is a difference
const memberDiffers: SameType<{ type: 'a' } | { type: 'b' }, { type: 'a' }> = true;
void [actionsMatch, inputsMatch, optionalDiffers, memberDiffers];

const hello = { t: 'hello', v: PROTOCOL, engine: '0123456789abcdef', room: 'K7QX', name: 'Ann', colour: PLAYER_COLOURS[0] };
const token = 'AbCdEfGhIjKlMnOpQrStUv';

/** one valid example of every action type */
const ACTIONS: PlayerAction[] = [
  { type: 'move', dir: 'ne' },
  { type: 'attack', targetId: 'a12' },
  { type: 'wait' },
  { type: 'use', slot: 0 },
  { type: 'use', slot: 3, target: { x: 4, y: 9 } },
  { type: 'equip', slot: 8 },
  { type: 'unequip', slot: 1 },
  { type: 'move_item', from: 0, to: TOTAL_SLOTS - 1 },
  { type: 'drop', slot: 2 },
  { type: 'pickup' },
  { type: 'transition' },
  { type: 'talk', targetId: 'a3' },
  { type: 'persuade', targetId: 'a3' },
  { type: 'search' },
  { type: 'toggle_sneak' },
  { type: 'choose_perk', perkId: 'tough' },
  { type: 'choose_option', index: 1 },
  { type: 'interact', pos: { x: 0, y: 0 } },
];

const CLIENT: unknown[] = [
  hello,
  { ...hello, token, lastN: 120, run: 2 },
  { t: 'input', area: 0, turn: 12, actions: [{ type: 'talk', targetId: 'a3' }, { type: 'move', dir: 'n' }], intent: 'decide' },
  { t: 'input', area: 2, turn: 0, actions: [], busy: true, intent: 'wait' },
  { t: 'presence', state: 'menu' },
  { t: 'typing', on: true },
  { t: 'chat', text: 'hello there' },
  { t: 'hash', n: 40, h: '00ff00ff00ff00ff' },
  { t: 'applied', n: 41 },
  { t: 'start' },
  { t: 'start', demo: 'fixture-western' },
  { t: 'options', deadlineMs: 3000, maxPlayers: 4 },
  { t: 'options', difficulty: 'hard' },
  { t: 'leave' },
  { t: 'ready', on: true },
  { t: 'profile', name: 'Kari', colour: PLAYER_COLOURS[3] },
  { t: 'world', demo: 'fixture-teen' },
  { t: 'ping', kind: 'follow', x: 3, y: 9 },
];

const roomInfo = { code: 'K7QX', world: { id: 'w-1', title: 'West', genre: 'western', language: 'en' }, players: 2, maxPlayers: 8, phase: 'playing', joinable: true };
const roster = [{ seat: 's1', pid: 'p1', name: 'Ann', colour: PLAYER_COLOURS[0], host: true, connected: true, presence: 'active', since: 1, ready: true }, { seat: 's2', pid: null, name: 'Bea', colour: PLAYER_COLOURS[1], host: false, connected: false, presence: 'off', since: 2, ready: false }];
const chatLine = { id: 1, seat: 's1', name: 'Ann', colour: PLAYER_COLOURS[0], text: 'hi', at: 5 };
const options = { maxPlayers: 8, deadlineMs: 2000, difficulty: 'normal' };
const turnEntry = { n: 3, run: 1, k: 'turn', inputs: [{ playerId: 'p1', actions: [{ type: 'wait' }] }, { playerId: 'p2', busy: true }], advance: true };

const SERVER: unknown[] = [
  { t: 'welcome', room: roomInfo, you: { seat: 's1', pid: 'p1', token, host: true }, roster, phase: 'playing', run: 1, options, world: { any: 'thing' }, worldId: 'w-1', snapshot: { n: 3, state: '{}' }, chat: [chatLine] },
  { t: 'welcome', room: { ...roomInfo, phase: 'lobby' }, you: { seat: 's2', pid: null, token, host: false }, roster, phase: 'lobby', run: 0, options, worldId: 'w-1', entries: [turnEntry], chat: [] },
  { t: 'entries', run: 1, es: [turnEntry] },
  { t: 'snapshot', run: 1, n: 30, state: '{}' },
  { t: 'run', run: 2, worldId: 'w-1', snapshot: { n: 0, state: '{}' } },
  { t: 'roster', seats: roster },
  { t: 'clock', n: 4, acted: ['p1'], waiting: ['p2'], deadlineInMs: 1200 },
  { t: 'chat', line: chatLine },
  { t: 'chat', line: { ...chatLine, id: 2, text: '', ping: { kind: 'help', x: 4, y: 5, area: 1 } } },
  { t: 'room', room: roomInfo, options },
  { t: 'typing', seat: 's2', on: false },
  { t: 'refusal', reasons: [{ action: { type: 'move', dir: 'n' }, reason: 'contested' }] },
  { t: 'error', code: 'stale', message: 'decide again' },
  { t: 'refused', code: 'outdated', message: 'reload', reload: true },
  { t: 'refused', code: 'room_closed', message: 'closed', reason: 'server_updated' },
  { t: 'closed', reason: 'idle', message: 'idle' },
  { t: 'bye', reason: 'restart' },
];

describe('client messages', () => {
  it('every message type parses, from text and from a value', () => {
    for (const m of CLIENT) {
      expect(parseClientMsg(m), JSON.stringify(m)).not.toBeNull();
      expect(parseClientMsg(JSON.stringify(m))).toEqual(parseClientMsg(m));
    }
    const types = new Set(CLIENT.map((m) => (m as { t: string }).t));
    expect([...types].sort()).toEqual(ClientMsg.options.map((o) => o.shape.t.value).sort());
  });

  it('every engine action parses unchanged in an input', () => {
    for (const a of ACTIONS) {
      const m = parseClientMsg({ t: 'input', area: 0, turn: 0, actions: [a], intent: 'decide' });
      expect(m && m.t === 'input' && m.actions[0]).toEqual(a);
    }
    expect(new Set(ACTIONS.map((a) => a.type)).size).toBe(PlayerActionSchema.options.length);
  });

  it('refuses unknown, malformed and out-of-bounds messages', () => {
    const bad: unknown[] = [
      null,
      42,
      'not json',
      '{"t":"hello"',
      [],
      { t: 'nope' },
      { t: 'leave', extra: 1, nested: { deep: 1 } }, // extra keys are stripped, so this one parses: checked below
      { ...hello, v: 2 },
      { ...hello, room: 'K7Q0' }, // no 0
      { ...hello, room: 'k7qx' },
      { ...hello, token: 'short' },
      { ...hello, name: '' },
      { ...hello, name: ' \u0007 ' },
      { ...hello, name: 'x'.repeat(25) },
      { ...hello, colour: '#000000' },
      { ...hello, engine: 'x'.repeat(65) },
      { ...hello, lastN: -1 },
      { t: 'input', area: 0, turn: 0, actions: [], intent: 'run' },
      { t: 'input', area: 0, turn: 0.5, actions: [], intent: 'wait' },
      { t: 'input', area: 0, turn: 0, actions: Array(LIMITS.actionsPerInput + 1).fill({ type: 'wait' }), intent: 'wait' },
      { t: 'input', area: 0, turn: 0, actions: [{ type: 'fly' }], intent: 'decide' },
      { t: 'input', area: 0, turn: 0, actions: [{ type: 'use', slot: TOTAL_SLOTS }], intent: 'decide' },
      { t: 'input', area: 0, turn: 0, actions: [{ type: 'move', dir: 'up' }], intent: 'decide' },
      { t: 'input', area: 0, turn: 0, actions: [{ type: 'attack', targetId: 'a'.repeat(33) }], intent: 'decide' },
      { t: 'input', area: 0, turn: 0, actions: [{ type: 'choose_option', index: -1 }], intent: 'decide' },
      { t: 'presence', state: 'away' },
      { t: 'chat', text: 'x'.repeat(LIMITS.chatRawMax + 1) },
      { t: 'hash', n: 10, h: 'XYZ' },
      { t: 'start', demo: '../etc/passwd' },
      { t: 'options', deadlineMs: 999 },
      { t: 'options', deadlineMs: 5001 },
      { t: 'options', maxPlayers: 13 },
      { t: 'options', maxPlayers: 1 },
    ];
    for (const m of bad) {
      if ((m as { t?: string })?.t === 'leave') continue;
      expect(parseClientMsg(m), JSON.stringify(m)).toBeNull();
    }
    expect(parseClientMsg({ t: 'leave', extra: 1 })).toEqual({ t: 'leave' });
  });

  it('refuses frames over the size limit and values nested too deep', () => {
    const big = JSON.stringify({ t: 'chat', text: 'x'.repeat(LIMITS.frameBytes) });
    expect(parseClientMsg(big)).toBeNull();
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(parseClientMsg({ t: 'leave', deep })).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'leave', deep }))).toBeNull();
  });

  it('names lose control characters and are trimmed; length counts code points', () => {
    const m = parseClientMsg({ ...hello, name: '  An\u0000n‮ ' });
    expect(m && m.t === 'hello' && m.name).toBe('Ann');
    const emoji = '🙂'.repeat(LIMITS.nameMax);
    expect(parseClientMsg({ ...hello, name: emoji })).not.toBeNull();
    expect(parseClientMsg({ ...hello, name: emoji + '🙂' })).toBeNull();
  });

  it('chat text: cleanChat keeps 1–200 code points after cleaning', () => {
    expect(cleanText('\u0001 hi \u007f')).toBe('hi');
    expect(codePoints('🙂a')).toBe(2);
    expect(cleanChat('  hello ')).toBe('hello');
    expect(cleanChat('   ')).toBeNull();
    expect(cleanChat('x'.repeat(LIMITS.chatMax))).toBe('x'.repeat(LIMITS.chatMax));
    expect(cleanChat('x'.repeat(LIMITS.chatMax + 1))).toBeNull();
    expect(cleanChat('🙂'.repeat(LIMITS.chatMax))).not.toBeNull();
    // the schema lets a long line through so the room can answer chat_long
    expect(parseClientMsg({ t: 'chat', text: 'x'.repeat(LIMITS.chatMax + 1) })).not.toBeNull();
  });
});

describe('MP3 D1 additions', () => {
  it('bounds of the lobby messages and pings', () => {
    for (const m of [
      { t: 'ready' },
      { t: 'ready', on: 'yes' },
      { t: 'profile', name: '   ', colour: PLAYER_COLOURS[0] },
      { t: 'profile', name: 'Kari', colour: '#000000' },
      { t: 'world', demo: 'Not A Demo' },
      { t: 'world' },
      { t: 'options', difficulty: 'impossible' },
      { t: 'ping', kind: 'dance', x: 1, y: 1 },
      { t: 'ping', kind: 'help', x: -1, y: 1 },
      { t: 'ping', kind: 'help', x: 1.5, y: 1 },
    ]) expect(parseClientMsg(m), JSON.stringify(m)).toBeNull();
    const p = parseClientMsg({ t: 'profile', name: '  Kari\u0007 ', colour: PLAYER_COLOURS[2] });
    expect(p).toEqual({ t: 'profile', name: 'Kari', colour: PLAYER_COLOURS[2] });
    // a roster entry must say ready; a ping line's kind is checked
    expect(parseServerMsg({ t: 'roster', seats: [{ ...roster[0], ready: undefined }] })).toBeNull();
    expect(parseServerMsg({ t: 'chat', line: { ...chatLine, ping: { kind: 'dance', x: 1, y: 1, area: 0 } } })).toBeNull();
    expect(LIMITS.rateShares.ping).toBe('chat');
  });
});

describe('peekHello', () => {
  it('reads the engine of any hello, whatever else it holds', () => {
    expect(peekHello(hello)).toEqual({ engine: hello.engine });
    expect(peekHello(JSON.stringify({ t: 'hello', engine: 'old' }))).toEqual({ engine: 'old' });
    // a later or earlier protocol, an otherwise invalid hello: still answered by version
    expect(peekHello({ t: 'hello', v: 99, engine: 'old', room: 7, name: null })).toEqual({ engine: 'old' });
    expect(parseClientMsg({ t: 'hello', v: 99, engine: 'old', room: 7, name: null })).toBeNull();
  });

  it('is null for anything that is not a hello with a string engine', () => {
    for (const m of [null, 'x', '[]', { t: 'input', engine: 'x' }, { t: 'hello' }, { t: 'hello', engine: 5 }, [{ t: 'hello', engine: 'x' }]]) expect(peekHello(m)).toBeNull();
    expect(peekHello('x'.repeat(LIMITS.frameBytes + 1))).toBeNull();
    expect(peekHello({ t: 'hello', engine: 'y'.repeat(500) })!.engine.length).toBe(LIMITS.engineMax);
  });
});

describe('server messages and log entries', () => {
  it('every message type parses', () => {
    for (const m of SERVER) expect(parseServerMsg(JSON.stringify(m)), JSON.stringify(m)).not.toBeNull();
    const types = new Set(SERVER.map((m) => (m as { t: string }).t));
    expect([...types].sort()).toEqual(ServerMsg.options.map((o) => o.shape.t.value).sort());
    expect(parseServerMsg({ t: 'refused', code: 'outdated', message: 'x', reload: false })).toBeNull();
    expect(parseServerMsg({ t: 'entries', run: 1, es: [] })).toBeNull();
    expect(parseServerMsg({ t: 'nope' })).toBeNull();
  });

  it('every log entry kind parses; bad ones do not', () => {
    const entries = [
      turnEntry,
      { n: 4, run: 1, k: 'gm', hook: 'intro', actions: [{ type: 'narrate', text: 'Dust.' }] },
      { n: 5, run: 1, k: 'join', seat: 's3', name: 'Cid', pid: 'p3', near: 'p1' },
      { n: 6, run: 1, k: 'away', pid: 'p2' },
      { n: 7, run: 1, k: 'back', pid: 'p2' },
      { n: 8, run: 1, k: 'leave', pid: 'p2' },
      { n: 9, run: 1, k: 'return', pid: 'p2', near: 'p1' },
    ];
    for (const e of entries) expect(LogEntrySchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    expect(new Set(entries.map((e) => e.k)).size).toBe(LogEntrySchema.options.length);
    for (const e of [
      { ...turnEntry, k: 'teleport' },
      { ...turnEntry, n: -1 },
      { ...turnEntry, advance: undefined },
      { n: 1, run: 1, k: 'gm', hook: 'lunch', actions: [] },
      { n: 1, run: 1, k: 'gm', hook: 'intro', actions: [{ type: 'explode' }] },
      { n: 1, run: 1, k: 'away', pid: 'x1' },
      { n: 1, run: 1, k: 'return', pid: 'p2' },
    ]) expect(LogEntrySchema.safeParse(e).success, JSON.stringify(e)).toBe(false);
  });

  it('refused codes have their own close codes; creating a room takes a demo or a world', () => {
    const codes = Object.values(REFUSED_CLOSE);
    expect(new Set(codes).size).toBe(RefusedCode.options.length);
    expect(codes.every((c) => c >= 4001 && c <= 4006)).toBe(true);
    expect(CreateRoomRequest.safeParse({ engine: 'v', demo: 'fixture-western' }).success).toBe(true);
    expect(CreateRoomRequest.safeParse({ engine: 'v', world: {}, options: { maxPlayers: 4 } }).success).toBe(true);
    expect(CreateRoomRequest.safeParse({ engine: 'v' }).success).toBe(false);
    expect(CreateRoomRequest.safeParse({ engine: 'v', demo: 'a', world: {} }).success).toBe(false);
    expect(CreateRoomRequest.safeParse({ engine: 'v', demo: 'a', options: { deadlineMs: 100 } }).success).toBe(false);
  });

  it('twelve distinct colours, one per possible seat', () => {
    expect(new Set(PLAYER_COLOURS).size).toBe(12);
    expect(LIMITS.maxPlayers.max).toBe(12);
  });
});
