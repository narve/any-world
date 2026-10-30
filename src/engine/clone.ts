/**
 * Fast structural copies of GameState for the pure engine API.
 *
 * structuredClone of a whole state cost ~1.1 ms per step (mostly the ~1–3k tile objects of the
 * map). cloneState instead:
 *  - shares the map's tile array and tile objects with the input (copy-on-write: every engine
 *    write to a tile goes through ctx.mutTile, which copies the array once and each touched tile
 *    once, see ctx.ts);
 *  - shares the log entries (they are immutable once written; the array itself is copied);
 *  - copies each player's `seen` as a Uint8Array (FOV rewrites it every step anyway);
 *  - deep-copies everything else with a plain-data copier (GameState is JSON-like data plus the
 *    `seen` typed array), which is several times faster than structuredClone for small objects.
 * Key order is preserved, so a cloned state serializes exactly like its source.
 */
import type { AreaMap, AreaState, GameState, PlayerState, Tile } from './types';
import type { TileCow } from './ctx';

/** deep copy of plain data (objects, arrays, typed arrays, primitives); key order preserved */
export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = deepClone(v[i]);
    return out as T;
  }
  if (ArrayBuffer.isView(v)) return (v as unknown as Uint8Array).slice() as T;
  const out: Record<string, unknown> = {};
  for (const k in v) {
    if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = deepClone((v as Record<string, unknown>)[k]);
  }
  return out as T;
}

function copySeen(seen: PlayerState['seen']): Uint8Array {
  return seen instanceof Uint8Array ? seen.slice() : Uint8Array.from((seen ?? []) as number[]);
}

function clonePlayer(ps: PlayerState): PlayerState {
  const out: Record<string, unknown> = {};
  for (const k in ps) {
    if (!Object.prototype.hasOwnProperty.call(ps, k)) continue;
    const v = (ps as unknown as Record<string, unknown>)[k];
    out[k] = k === 'seen' ? copySeen(v as PlayerState['seen']) : deepClone(v);
  }
  return out as unknown as PlayerState;
}

function clonePlayers(players: GameState['players']): GameState['players'] {
  const out: GameState['players'] = {};
  for (const id in players) if (Object.prototype.hasOwnProperty.call(players, id)) out[id] = clonePlayer(players[id]);
  return out;
}

function cloneMap(map: AreaMap): AreaMap {
  const out: Record<string, unknown> = {};
  for (const k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    const v = (map as unknown as Record<string, unknown>)[k];
    out[k] = k === 'tiles' ? v : deepClone(v);
  }
  return out as unknown as AreaMap;
}

function cloneArea(area: AreaState): AreaState {
  const out: Record<string, unknown> = {};
  for (const k in area) {
    if (!Object.prototype.hasOwnProperty.call(area, k)) continue;
    const v = (area as unknown as Record<string, unknown>)[k];
    out[k] = k === 'map' ? cloneMap(v as AreaMap) : deepClone(v);
  }
  return out as unknown as AreaState;
}

/**
 * A copy of `s` the engine may mutate (through mutTile for tiles), plus the copy-on-write record
 * for the shared tile array. `s` itself is never changed by working on the copy.
 */
export function cloneState(s: GameState): { state: GameState; cow: TileCow } {
  const out: Record<string, unknown> = {};
  for (const k in s) {
    if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
    const v = (s as unknown as Record<string, unknown>)[k];
    if (k === 'area') out[k] = cloneArea(v as AreaState);
    else if (k === 'players') out[k] = clonePlayers(v as GameState['players']);
    else if (k === 'log') out[k] = Array.isArray(v) ? v.slice() : [];
    else out[k] = deepClone(v);
  }
  const state = out as unknown as GameState;
  const tiles: Tile[] = state.area.map.tiles;
  return { state, cow: { src: tiles, owned: new Set() } };
}
