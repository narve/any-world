/**
 * Pure movement helpers for the controller: camera-relative direction keys, click-to-travel path
 * steps and the "a hostile came into view" interrupt. No DOM.
 */
import type { Dir, GameState, Pos } from '../engine/types';
import { findPath, passability } from '../engine/index';
import { playerOf } from './view';

const DIRS: readonly Dir[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const DELTA: Record<Dir, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };

/**
 * Screen-relative → map direction. Camera step 0 looks north (screen-up = n); each step turns the
 * view 90° so screen-up becomes e, s, w.
 */
export function rotateDir(dir: Dir, cameraStep: number): Dir {
  const s = (((cameraStep | 0) % 4) + 4) % 4;
  return DIRS[(DIRS.indexOf(dir) + s * 2) % 8];
}

export function dirTo(from: Pos, to: Pos): Dir | null {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  for (const d of DIRS) if (DELTA[d][0] === dx && DELTA[d][1] === dy) return d;
  return null;
}

export function cheb(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function seenAt(state: GameState, x: number, y: number): number {
  const seen = state.area.seen as ArrayLike<number>;
  return seen[y * state.area.map.width + x] ?? 0;
}

/** ids of hostile actors standing on currently visible tiles */
export function visibleHostiles(state: GameState): Set<string> {
  const out = new Set<string>();
  for (const a of state.area.actors) {
    if (a.id === state.player.actorId || a.hp <= 0 || a.faction !== 'hostile' || a.allyOf) continue;
    if (seenAt(state, a.pos.x, a.pos.y) === 2) out.add(a.id);
  }
  return out;
}

export function actorAt(state: GameState, p: Pos) {
  return state.area.actors.find((a) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y);
}

/**
 * The next direction to walk toward `dest`, over explored, passable tiles (and, for a destination
 * in the unknown, unexplored ones), routing around other actors (except at the destination).
 * null = no route or already there.
 */
export function travelStep(state: GameState, dest: Pos): Dir | null {
  const path = travelPath(state, dest);
  if (!path || !path.length) return null;
  return dirTo(playerOf(state).pos, path[0]);
}

/**
 * The whole click-to-travel route to `dest` (excluding the player's tile, including `dest`), over
 * explored passable tiles and around other actors. Unexplored tiles count as open ("walk toward"):
 * the route is re-planned every step as the map reveals itself, and its first step is always a
 * visible tile, so it never walks into an unseen wall and reveals nothing the player has not seen
 * (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §3.4, §3.5). null = no known way; [] = already there.
 */
export function travelPath(state: GameState, dest: Pos): Pos[] | null {
  const p = playerOf(state).pos;
  if (p.x === dest.x && p.y === dest.y) return [];
  const map = state.area.map;
  if (dest.x < 0 || dest.y < 0 || dest.x >= map.width || dest.y >= map.height) return null;
  const pass = passability(state);
  const known = (x: number, y: number) => seenAt(state, x, y) !== 0;
  // through the unknown everything might be floor; what is known must be passable
  const open = (x: number, y: number) => (known(x, y) ? pass(x, y) : x > 0 && y > 0 && x < map.width - 1 && y < map.height - 1);
  const occupied = new Set(state.area.actors.filter((a) => a.hp > 0 && a.id !== state.player.actorId).map((a) => a.pos.y * map.width + a.pos.x));
  const ok = (x: number, y: number) => {
    if (!open(x, y)) return false;
    if (x === dest.x && y === dest.y) return true;
    // only actors the player can see are routed around
    return !(seenAt(state, x, y) === 2 && occupied.has(y * map.width + x));
  };
  if (!open(dest.x, dest.y)) return null;
  let path = findPath(map.width, map.height, p, dest, ok, { maxNodes: 6000 });
  // blocked by a crowd? try ignoring actors that are not adjacent to the player
  if (!path) {
    const loose = (x: number, y: number) => open(x, y) && (cheb({ x, y }, p) > 1 || !occupied.has(y * map.width + x));
    path = findPath(map.width, map.height, p, dest, loose, { maxNodes: 6000 });
  }
  return path && path.length ? path : null;
}
