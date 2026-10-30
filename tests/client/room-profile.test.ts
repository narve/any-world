/**
 * MP3 D1: the room profile and seat tokens (src/client/room/profile.ts): defaults, validation as the
 * server cleans names, the token store kept to 20 codes and 7 days, drop rules, colour names, and
 * storage that is missing or throws.
 */
import { describe, it, expect } from 'vitest';
import {
  COLOUR_KEYS,
  colourName,
  defaultProfile,
  dropSeat,
  loadProfile,
  PROFILE_KEY,
  saveProfile,
  saveSeat,
  SEATS_KEY,
  SEATS_MAX,
  seatCodes,
  seatToken,
  type KeyValueStore,
} from '../../src/client/room/profile';
import { PLAYER_COLOURS } from '../../src/net/protocol';
import en from '../../src/client/i18n/en';

function mem(): KeyValueStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const broken: KeyValueStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('full');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const tok = (i: number) => `tok${String(i).padStart(2, '0')}${'x'.repeat(17)}`;
const DAY = 24 * 60 * 60 * 1000;
const CODES = ['K7QX', 'ABCD', 'WXYZ', 'HJKM', 'NPQR', 'STUV', '2345', '6789', 'A2B3', 'C4D5', 'E6F7', 'G8H9', 'J2K3', 'M4N5', 'P6Q7', 'R8S9', 'T2U3', 'V4W5', 'X6Y7', 'Z8A9', 'B2C3', 'D4E5'];

describe('profile', () => {
  it('a default profile: "Player n" and one of the colours; saved and loaded cleaned', () => {
    const p = defaultProfile(() => 0.5);
    expect(p.name).toBe('Player 50');
    expect(PLAYER_COLOURS).toContain(p.colour);
    const s = mem();
    expect(loadProfile(s)).toBeNull();
    expect(saveProfile({ name: '  Kari\u0007 ', colour: PLAYER_COLOURS[1] }, s)).toBe(true);
    expect(JSON.parse(s.m.get(PROFILE_KEY)!)).toEqual({ name: 'Kari', colour: PLAYER_COLOURS[1] });
    expect(loadProfile(s)).toEqual({ name: 'Kari', colour: PLAYER_COLOURS[1] });
  });

  it('refuses invalid names and colours; a stored bad profile reads as none', () => {
    const s = mem();
    expect(saveProfile({ name: '   ', colour: PLAYER_COLOURS[0] }, s)).toBe(false);
    expect(saveProfile({ name: 'x'.repeat(25), colour: PLAYER_COLOURS[0] }, s)).toBe(false);
    expect(saveProfile({ name: 'Kari', colour: '#000000' as (typeof PLAYER_COLOURS)[number] }, s)).toBe(false);
    s.m.set(PROFILE_KEY, '{"name":"Kari","colour":"#123456"}');
    expect(loadProfile(s)).toBeNull();
    s.m.set(PROFILE_KEY, 'not json');
    expect(loadProfile(s)).toBeNull();
  });

  it('storage that throws or is missing never throws', () => {
    expect(loadProfile(broken)).toBeNull();
    expect(saveProfile({ name: 'Kari', colour: PLAYER_COLOURS[0] }, broken)).toBe(false);
    expect(saveSeat('K7QX', tok(1), 0, broken)).toBe(false);
    expect(seatToken('K7QX', 0, broken)).toBeNull();
    expect(() => dropSeat('K7QX', 0, broken)).not.toThrow();
    expect(loadProfile(null)).toBeNull();
    expect(saveProfile({ name: 'Kari', colour: PLAYER_COLOURS[0] }, null)).toBe(false);
  });

  it('every colour has a name in the catalog', () => {
    for (const c of PLAYER_COLOURS) expect(COLOUR_KEYS[c] in en, c).toBe(true);
    expect(colourName('#3cb44b')).toBe('green');
  });
});

describe('seat tokens', () => {
  it('kept per room code; a later save refreshes it; drop forgets one', () => {
    const s = mem();
    expect(saveSeat('K7QX', tok(1), 1000, s)).toBe(true);
    expect(saveSeat('ABCD', tok(2), 2000, s)).toBe(true);
    expect(seatToken('K7QX', 3000, s)).toBe(tok(1));
    expect(seatCodes(3000, s)).toEqual(['ABCD', 'K7QX']);
    saveSeat('K7QX', tok(3), 4000, s);
    expect(seatToken('K7QX', 5000, s)).toBe(tok(3));
    expect(seatCodes(5000, s)).toEqual(['K7QX', 'ABCD']);
    dropSeat('K7QX', 5000, s);
    expect(seatToken('K7QX', 5000, s)).toBeNull();
    expect(seatCodes(5000, s)).toEqual(['ABCD']);
    // invalid codes or tokens are not kept
    expect(saveSeat('k7qx', tok(1), 0, s)).toBe(false);
    expect(saveSeat('K7QX', 'short', 0, s)).toBe(false);
  });

  it('at most 20 codes (the newest) and none older than 7 days', () => {
    const s = mem();
    CODES.forEach((c, i) => saveSeat(c, tok(i), i * 1000, s));
    const kept = seatCodes(CODES.length * 1000, s);
    expect(kept).toHaveLength(SEATS_MAX);
    expect(kept).not.toContain(CODES[0]);
    expect(kept).not.toContain(CODES[1]);
    expect(kept[0]).toBe(CODES.at(-1));
    expect(Object.keys(JSON.parse(s.m.get(SEATS_KEY)!))).toHaveLength(SEATS_MAX);
    // a week later only the ones used within 7 days are left
    const now = 7 * DAY + 15_500;
    expect(seatCodes(now, s)).toEqual(CODES.slice(16).reverse());
    expect(seatToken(CODES[3], now, s)).toBeNull();
  });

  it('ignores junk in the store', () => {
    const s = mem();
    s.m.set(SEATS_KEY, JSON.stringify({ K7QX: { token: tok(1), at: 5 }, bad: { token: tok(2), at: 5 }, ABCD: { token: 3, at: 5 }, WXYZ: null, HJKM: { token: tok(4), at: 'x' } }));
    expect(seatCodes(10, s)).toEqual(['K7QX']);
    s.m.set(SEATS_KEY, '[1,2]');
    expect(seatCodes(10, s)).toEqual([]);
  });
});
