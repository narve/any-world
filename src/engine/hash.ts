/**
 * hashState: a 64-bit fingerprint (16 hex chars) of a whole GameState, for checking that two copies
 * of a run agree (MP2: the room server and the clients compare it every few turns; tests: clone,
 * save round trips, step vs fastStep).
 *
 * FNV-1a over a canonical walk of the state, in two independent 32-bit lanes (Math.imul, no BigInt):
 *  - objects: keys sorted, `undefined` values skipped (an absent optional field and one set to
 *    undefined hash alike); arrays in order; numbers through String(n); every value tagged by type
 *    and strings length-prefixed, so different shapes never feed the same bytes;
 *  - `players` in `party` order (never by key order), then any player outside the party by id;
 *  - every player's `seen` as its bytes, whatever its form (Uint8Array or number[]: deserialize,
 *    fastStep and clone produce different ones);
 *  - the map tiles through a fixed-order tile walker (thousands of tiles; no key sorting).
 * The log is included (it is capped at MAX_LOG); the world is identified by `worldId`.
 */
import type { AreaMap, GameState, PlayerState, Tile } from './types';

const OFFSET_A = 0x811c9dc5;
const OFFSET_B = 0xcbf29ce4;
const PRIME_A = 0x01000193;
const PRIME_B = 0x5bd1e995;

class Hasher {
  a = OFFSET_A;
  b = OFFSET_B;

  /** one 16-bit unit */
  unit(c: number): void {
    this.a = Math.imul(this.a ^ (c & 0xffff), PRIME_A);
    this.b = Math.imul(this.b ^ (c & 0xffff), PRIME_B);
    this.b ^= this.b >>> 15;
  }

  str(s: string): void {
    this.tag(0x73, s.length);
    for (let i = 0; i < s.length; i++) this.unit(s.charCodeAt(i));
  }

  num(n: number): void {
    const t = String(n);
    this.unit(0x6e);
    for (let i = 0; i < t.length; i++) this.unit(t.charCodeAt(i));
    this.unit(0x3b);
  }

  /** a type tag with a small count (lengths, sizes) */
  tag(kind: number, count: number): void {
    this.unit(kind);
    this.unit(count & 0xffff);
    this.unit((count >>> 16) & 0xffff);
  }

  bytes(v: ArrayLike<number>): void {
    this.tag(0x62, v.length);
    for (let i = 0; i < v.length; i++) this.unit((v[i] ?? 0) & 0xff);
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

function walk(h: Hasher, v: unknown): void {
  if (v === null) return h.unit(0x7a);
  switch (typeof v) {
    case 'number':
      return h.num(v);
    case 'string':
      return h.str(v);
    case 'boolean':
      return h.unit(v ? 0x74 : 0x66);
    case 'undefined':
      return h.unit(0x75);
    case 'object':
      break;
    default:
      return h.str(String(v));
  }
  if (Array.isArray(v)) {
    h.tag(0x5b, v.length);
    for (const x of v) walk(h, x);
    return;
  }
  if (ArrayBuffer.isView(v)) return h.bytes(v as unknown as ArrayLike<number>);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  h.tag(0x7b, keys.length);
  for (const k of keys) {
    h.str(k);
    walk(h, o[k]);
  }
}

/** a tile's fields in a fixed order (absent fields hash as absent) */
function walkTile(h: Hasher, t: Tile): void {
  h.str(t.kind);
  if (t.terrain !== undefined) {
    h.unit(1);
    h.str(t.terrain);
  }
  if (t.terrainTtl !== undefined) {
    h.unit(2);
    h.num(t.terrainTtl);
  }
  if (t.region !== undefined) {
    h.unit(3);
    h.num(t.region);
  }
  if (t.lamp !== undefined) h.unit(t.lamp ? 4 : 5);
  if (t.interacted !== undefined) h.unit(t.interacted ? 6 : 7);
  if (t.terrainUnder !== undefined) {
    h.unit(8);
    h.str(t.terrainUnder.terrain);
    if (t.terrainUnder.interacted !== undefined) h.unit(t.terrainUnder.interacted ? 9 : 10);
  }
  h.unit(0x7c);
}

function walkMap(h: Hasher, map: AreaMap): void {
  const o = map as unknown as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  h.tag(0x7b, keys.length);
  for (const k of keys) {
    h.str(k);
    if (k === 'tiles' && Array.isArray(map.tiles)) {
      h.tag(0x5b, map.tiles.length);
      for (const t of map.tiles) walkTile(h, t);
    } else walk(h, o[k]);
  }
}

function walkPlayer(h: Hasher, ps: PlayerState): void {
  const o = ps as unknown as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  h.tag(0x7b, keys.length);
  for (const k of keys) {
    h.str(k);
    if (k === 'seen') h.bytes(ps.seen ?? []);
    else walk(h, o[k]);
  }
}

/** the 64-bit fingerprint of `state` as 16 hex chars; equal states (as data) hash equal */
export function hashState(state: GameState): string {
  const h = new Hasher();
  const o = state as unknown as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  h.tag(0x7b, keys.length);
  for (const k of keys) {
    h.str(k);
    if (k === 'players') {
      const players = state.players;
      const ids = [...state.party, ...Object.keys(players).filter((id) => !state.party.includes(id)).sort()];
      h.tag(0x70, ids.length);
      for (const id of ids) {
        h.str(id);
        if (players[id]) walkPlayer(h, players[id]);
        else h.unit(0x7a);
      }
    } else if (k === 'area') {
      const area = state.area as unknown as Record<string, unknown>;
      const ak = Object.keys(area)
        .filter((x) => area[x] !== undefined)
        .sort();
      h.tag(0x7b, ak.length);
      for (const x of ak) {
        h.str(x);
        if (x === 'map') walkMap(h, state.area.map);
        else walk(h, area[x]);
      }
    } else walk(h, o[k]);
  }
  return h.hex();
}
