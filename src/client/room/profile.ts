/**
 * The player's room profile and seat tokens (MP3 design §2.2, §2.3), in localStorage:
 *  - `anyworld.mp.profile`: { name, colour }, asked once (the first create or join) and kept;
 *  - `anyworld.mp.seats`: { [code]: { token, at } }, so a reload rejoins the same seat; at most
 *    SEATS_MAX codes (the newest), each kept SEAT_DAYS days from its last use.
 * Every access is wrapped in try/catch as in storage.ts: storage can be missing, full or blocked,
 * and rooms must still work (just without remembering). Nothing here touches the single-player save.
 */
import { t, type MessageKey } from '../i18n/index';
import { Code, Colour, Name, PLAYER_COLOURS, Token } from '../../net/protocol';

export const PROFILE_KEY = 'anyworld.mp.profile';
export const SEATS_KEY = 'anyworld.mp.seats';
export const SEATS_MAX = 20;
export const SEAT_DAYS = 7;
const SEAT_MS = SEAT_DAYS * 24 * 60 * 60 * 1000;

export type PlayerColour = (typeof PLAYER_COLOURS)[number];

export interface Profile {
  name: string;
  colour: PlayerColour;
}

export interface SeatRecord {
  token: string;
  at: number;
}

/** what profile.ts needs of localStorage (tests pass a Map-backed one) */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(s?: KeyValueStore | null): KeyValueStore | null {
  if (s !== undefined) return s;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson(key: string, s?: KeyValueStore | null): unknown {
  try {
    const txt = store(s)?.getItem(key);
    return txt ? (JSON.parse(txt) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown, s?: KeyValueStore | null): boolean {
  try {
    const st = store(s);
    if (!st) return false;
    st.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/** the stored profile, or null (none yet, or not a valid name and colour) */
export function loadProfile(s?: KeyValueStore | null): Profile | null {
  const v = readJson(PROFILE_KEY, s) as Partial<Profile> | null;
  if (!v || typeof v !== 'object') return null;
  const name = Name.safeParse(v.name);
  const colour = Colour.safeParse(v.colour);
  return name.success && colour.success ? { name: name.data, colour: colour.data } : null;
}

/** keeps the profile (the name cleaned as the server does); false when it is invalid or storage fails */
export function saveProfile(p: Profile, s?: KeyValueStore | null): boolean {
  const name = Name.safeParse(p.name);
  const colour = Colour.safeParse(p.colour);
  if (!name.success || !colour.success) return false;
  return writeJson(PROFILE_KEY, { name: name.data, colour: colour.data }, s);
}

/** a first profile for the name sheet: "Player 37" and a random colour */
export function defaultProfile(rand: () => number = Math.random): Profile {
  const n = 1 + Math.floor(rand() * 99);
  const colour = PLAYER_COLOURS[Math.floor(rand() * PLAYER_COLOURS.length) % PLAYER_COLOURS.length];
  return { name: t('lobby.defaultName', { n }), colour };
}

/**
 * The seat records, pruned and newest first: valid codes and tokens only, none older than SEAT_DAYS,
 * the newest SEATS_MAX. (An array: an object would put codes like "2345" first, as integer keys.)
 */
function seats(now: number, s?: KeyValueStore | null): [string, SeatRecord][] {
  const v = readJson(SEATS_KEY, s);
  const out: [string, SeatRecord][] = [];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [code, r] of Object.entries(v as Record<string, Partial<SeatRecord>>)) {
      if (!Code.safeParse(code).success || !r || typeof r !== 'object') continue;
      if (!Token.safeParse(r.token).success || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
      if (now - r.at > SEAT_MS) continue;
      out.push([code, { token: r.token!, at: r.at }]);
    }
  }
  out.sort((a, b) => b[1].at - a[1].at);
  return out.slice(0, SEATS_MAX);
}

/** the stored seat token for a room code, or null */
export function seatToken(code: string, now: number, s?: KeyValueStore | null): string | null {
  return seats(now, s).find(([c]) => c === code)?.[1].token ?? null;
}

/** the room codes with a stored seat (the start page's "Rejoin") */
export function seatCodes(now: number, s?: KeyValueStore | null): string[] {
  return seats(now, s).map(([c]) => c);
}

/** keeps (or refreshes) the seat token of a room */
export function saveSeat(code: string, token: string, now: number, s?: KeyValueStore | null): boolean {
  if (!Code.safeParse(code).success || !Token.safeParse(token).success) return false;
  const kept = [[code, { token, at: now }] as [string, SeatRecord], ...seats(now, s).filter(([c]) => c !== code)].slice(0, SEATS_MAX);
  return writeJson(SEATS_KEY, Object.fromEntries(kept), s);
}

/** forgets the seat of a room (a closed room, a bad token) */
export function dropSeat(code: string, now: number, s?: KeyValueStore | null): void {
  const all = seats(now, s);
  if (!all.some(([c]) => c === code)) return;
  writeJson(SEATS_KEY, Object.fromEntries(all.filter(([c]) => c !== code)), s);
}

/** the i18n key of each player colour's name ("You are Kari 2, green") */
export const COLOUR_KEYS: Record<PlayerColour, MessageKey> = {
  '#e6194b': 'lobby.colours.red',
  '#3cb44b': 'lobby.colours.green',
  '#ffe119': 'lobby.colours.yellow',
  '#4363d8': 'lobby.colours.blue',
  '#f58231': 'lobby.colours.orange',
  '#911eb4': 'lobby.colours.purple',
  '#42d4f4': 'lobby.colours.cyan',
  '#f032e6': 'lobby.colours.magenta',
  '#bfef45': 'lobby.colours.lime',
  '#fabed4': 'lobby.colours.pink',
  '#469990': 'lobby.colours.teal',
  '#dcbeff': 'lobby.colours.lavender',
};

/** a player colour's name in the UI language */
export function colourName(c: PlayerColour): string {
  return t(COLOUR_KEYS[c]);
}
