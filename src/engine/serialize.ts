/** Save/load. The Uint8Array visibility grid is stored as a compact digit string ("0"/"1"/"2"). */
import type { WorldSpec } from '../schema/world';
import type { GameState } from './types';
import { registerWorld, worldIdOf } from './registry';

const FORMAT = 'anyworld-save';

export function serialize(state: GameState): string {
  const seen = state.area.seen;
  let packed = '';
  for (let i = 0; i < seen.length; i++) packed += String(seen[i] ?? 0);
  const plain = { ...state, area: { ...state.area, seen: packed } };
  return JSON.stringify({ format: FORMAT, state: plain });
}

export function deserialize(world: WorldSpec, json: string): GameState {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('save is not valid JSON');
  }
  const d = doc as { format?: string; state?: GameState & { area: { seen: unknown } } };
  if (!d || d.format !== FORMAT || !d.state) throw new Error('not an AnyWorld save');
  const s = d.state;
  if (s.version !== 1) throw new Error(`unsupported save version ${String(s.version)}`);
  if (!s.area || !s.area.map || !Array.isArray(s.area.actors) || !Array.isArray(s.rng) || s.rng.length !== 4) throw new Error('save is corrupt');
  const id = worldIdOf(world);
  if (s.worldId !== id) throw new Error(`save belongs to a different world (${s.worldId}, expected ${id})`);
  const raw: unknown = (s.area as { seen: unknown }).seen;
  const n = s.area.map.width * s.area.map.height;
  const seen = new Uint8Array(n);
  if (typeof raw === 'string') for (let i = 0; i < n && i < raw.length; i++) seen[i] = raw.charCodeAt(i) - 48;
  else if (Array.isArray(raw)) for (let i = 0; i < n && i < raw.length; i++) seen[i] = Number(raw[i]) || 0;
  s.area.seen = seen;
  registerWorld(world);
  return s as GameState;
}
