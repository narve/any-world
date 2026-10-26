/**
 * Save/load. Each player's visibility grid (values 0/1/2) is stored run-length coded: "0x812,1x40,2x9"
 * (fog is long runs, so a large map of a full party stays a few KB). Only version-2 saves load; an
 * older save is refused ("unsupported save version"), and the client starts a new game.
 */
import type { WorldSpec } from '../schema/world';
import type { GameState, PlayerState } from './types';
import { registerWorld, worldIdOf } from './registry';

const FORMAT = 'anyworld-save';

/** run-length code of a fog grid: "<value>x<count>" runs joined by "," ("" for an empty grid) */
export function packSeen(seen: ArrayLike<number>): string {
  const runs: string[] = [];
  let i = 0;
  while (i < seen.length) {
    const v = seen[i] ?? 0;
    let j = i + 1;
    while (j < seen.length && (seen[j] ?? 0) === v) j++;
    runs.push(`${v}x${j - i}`);
    i = j;
  }
  return runs.join(',');
}

/** decodes packSeen into a grid of `n` tiles (missing tiles 0; malformed runs are skipped) */
export function unpackSeen(raw: unknown, n: number): Uint8Array {
  const seen = new Uint8Array(n);
  if (typeof raw === 'string') {
    let i = 0;
    for (const run of raw ? raw.split(',') : []) {
      const m = /^([0-2])x(\d+)$/.exec(run);
      if (!m) continue;
      const v = Number(m[1]);
      const end = Math.min(n, i + Number(m[2]));
      if (v) seen.fill(v, i, end);
      i = end;
      if (i >= n) break;
    }
  } else if (Array.isArray(raw)) {
    for (let i = 0; i < n && i < raw.length; i++) seen[i] = Number(raw[i]) || 0;
  }
  return seen;
}

export function serialize(state: GameState): string {
  const players: Record<string, unknown> = {};
  for (const id of Object.keys(state.players)) {
    const ps = state.players[id];
    players[id] = { ...ps, seen: packSeen(ps.seen) };
  }
  const plain = { ...state, players };
  return JSON.stringify({ format: FORMAT, state: plain });
}

export function deserialize(world: WorldSpec, json: string): GameState {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('save is not valid JSON');
  }
  const d = doc as { format?: string; state?: GameState };
  if (!d || d.format !== FORMAT || !d.state) throw new Error('not an AnyWorld save');
  const s = d.state;
  if (s.version !== 2) throw new Error(`unsupported save version ${String(s.version)}`);
  if (!s.area || !s.area.map || !Array.isArray(s.area.actors) || !Array.isArray(s.rng) || s.rng.length !== 4) throw new Error('save is corrupt');
  if (!s.players || typeof s.players !== 'object' || !Array.isArray(s.party) || !s.party.length) throw new Error('save is corrupt');
  for (const id of s.party) if (!s.players[id] || typeof s.players[id] !== 'object') throw new Error('save is corrupt');
  const id = worldIdOf(world);
  if (s.worldId !== id) throw new Error(`save belongs to a different world (${s.worldId}, expected ${id})`);
  const n = s.area.map.width * s.area.map.height;
  for (const pid of Object.keys(s.players)) {
    const ps = s.players[pid] as PlayerState;
    ps.seen = unpackSeen((ps as { seen: unknown }).seen, n);
  }
  registerWorld(world);
  return s as GameState;
}
