/// <reference types="vite/client" />
/**
 * Dev-page helpers: load fixture worlds from content/worlds, build a demo GameState around a
 * generated (or local fallback) area map, and a tiny FOV. Not used by the game itself.
 */
import { parseWorld } from '../../schema/refs';
import type { WorldSpec, AreaPlan } from '../../schema/world';
import type { AreaMap, AreaState, GameState, ActorInstance, FloorItem, ItemKnowledgeState, Pos, Rng, Tile } from '../../engine/types';
import { TOTAL_SLOTS } from '../../engine/types';
import { abstractMap, syntheticDreamWorld } from './abstract';

/** name of the dev-only synthetic dream world (used for fixture-dream until that file exists) */
export const SYNTHETIC_DREAM = 'synthetic-dream';

const raw = import.meta.glob('../../../content/worlds/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export function worldNames(): string[] {
  return Object.keys(raw)
    .map((p) => p.split('/').pop()!.replace(/\.json$/, ''))
    .sort();
}

export function loadWorld(name: string | null): { name: string; world: WorldSpec; synthetic?: boolean } {
  const names = worldNames();
  if (name === SYNTHETIC_DREAM || (name === 'fixture-dream' && !names.includes(name))) {
    const base = loadWorld(names.find((n) => n.startsWith('fixture-')) ?? names[0]);
    return { name: SYNTHETIC_DREAM, world: syntheticDreamWorld(base.world), synthetic: true };
  }
  const pick = name && names.includes(name) ? name : names.find((n) => n.startsWith('fixture-')) ?? names[0];
  const key = Object.keys(raw).find((p) => p.endsWith(`/${pick}.json`))!;
  const res = parseWorld(raw[key]);
  if (!res.ok) throw new Error(`world ${pick} failed to validate:\n${res.errors.slice(0, 10).join('\n')}`);
  return { name: pick, world: res.world };
}

/** Small deterministic RNG implementing the engine Rng contract. */
export function devRng(seed: number): Rng {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    dice: (spec) => {
      const m = /^(\d+)d(\d+)$/.exec(spec);
      if (!m) return 0;
      let t = 0;
      for (let i = 0; i < +m[1]; i++) t += 1 + Math.floor(next() * +m[2]);
      return t;
    },
    state: () => [s, 0, 0, 1],
  };
  return rng;
}

/** Fallback map: rooms joined by corridors, doors, lamps, a pool and scattered terrain. */
export function localTestMap(plan: AreaPlan, world: WorldSpec, rng: Rng): AreaMap {
  const W = 44;
  const H = 32;
  const tiles: Tile[] = Array.from({ length: W * H }, () => ({ kind: 'wall' as const }));
  const at = (x: number, y: number) => tiles[y * W + x];
  const rooms: { x: number; y: number; w: number; h: number }[] = [];
  for (let tries = 0; tries < 200 && rooms.length < 9; tries++) {
    const w = rng.int(5, 10);
    const h = rng.int(4, 8);
    const x = rng.int(1, W - w - 2);
    const y = rng.int(1, H - h - 2);
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    rooms.push({ x, y, w, h });
  }
  rooms.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[y * W + x] = { kind: 'floor', region: i };
  });
  const centre = (r: (typeof rooms)[number]): Pos => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) });
  for (let i = 1; i < rooms.length; i++) {
    const a = centre(rooms[i - 1]);
    const b = centre(rooms[i]);
    let x = a.x;
    let y = a.y;
    while (x !== b.x) {
      if (at(x, y).kind === 'wall') tiles[y * W + x] = { kind: 'floor' };
      x += Math.sign(b.x - x);
    }
    while (y !== b.y) {
      if (at(x, y).kind === 'wall') tiles[y * W + x] = { kind: 'floor' };
      y += Math.sign(b.y - y);
    }
  }
  // doors where corridors pierce room walls
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const t = at(x, y);
      if (t.kind !== 'floor' || t.region !== undefined) continue;
      const horiz = at(x - 1, y).kind === 'wall' && at(x + 1, y).kind === 'wall';
      const vert = at(x, y - 1).kind === 'wall' && at(x, y + 1).kind === 'wall';
      const nearRoom = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some((n) => n.region !== undefined);
      if ((horiz || vert) && nearRoom && rng.chance(0.7)) tiles[y * W + x] = { kind: rng.chance(0.5) ? 'door' : 'door_open' };
    }
  // a pool in the largest room
  const big = [...rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  for (let y = big.y + 1; y < big.y + Math.min(3, big.h - 1); y++) for (let x = big.x + big.w - 3; x < big.x + big.w - 1; x++) tiles[y * W + x] = { kind: 'water' };
  // lamps
  const freq = plan.lighting.lamps?.frequency ?? 0;
  if (freq > 0)
    for (const r of rooms) {
      tiles[r.y * W + r.x].lamp = true;
      if (rng.chance(0.5)) tiles[(r.y + r.h - 1) * W + r.x + r.w - 1].lamp = true;
    }
  // terrain
  for (const tp of plan.terrain ?? []) {
    for (let i = 0; i < W * H; i++) if (tiles[i].kind === 'floor' && !tiles[i].lamp && rng.chance(tp.density)) tiles[i].terrain = tp.terrain;
  }
  const start = centre(rooms[0]);
  const exit = centre(rooms[rooms.length - 1]);
  tiles[start.y * W + start.x] = { kind: 'start' };
  tiles[exit.y * W + exit.x] = { kind: 'transition' };
  void world;
  return {
    width: W,
    height: H,
    tiles,
    start,
    exit,
    regions: rooms.map((r, i) => ({ id: i, centre: centre(r), size: r.w * r.h })),
  };
}

const PASSABLE = new Set(['floor', 'start', 'door_open', 'transition', 'water', 'door']);

export function isOpaqueTile(map: AreaMap, world: WorldSpec, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  const t = map.tiles[y * map.width + x];
  if (t.kind === 'wall' || t.kind === 'door') return true;
  if (t.terrain) return world.terrains.find((d) => d.id === t.terrain)?.blocksSight ?? false;
  return false;
}

/** Simple ray-cast FOV (dev only; the engine has its own). */
export function simpleFov(map: AreaMap, world: WorldSpec, o: Pos, r: number): Set<number> {
  const out = new Set<number>();
  for (let a = 0; a < 360; a += 0.75) {
    const dx = Math.cos((a * Math.PI) / 180);
    const dy = Math.sin((a * Math.PI) / 180);
    let x = o.x + 0.5;
    let y = o.y + 0.5;
    for (let s = 0; s <= r; s += 0.4) {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) break;
      out.add(ty * map.width + tx);
      if (isOpaqueTile(map, world, tx, ty) && !(tx === o.x && ty === o.y)) break;
      x += dx * 0.4;
      y += dy * 0.4;
    }
  }
  return out;
}

function bfs(map: AreaMap, from: Pos, world: WorldSpec): Int32Array {
  const d = new Int32Array(map.width * map.height).fill(-1);
  const q: number[] = [from.y * map.width + from.x];
  d[q[0]] = 0;
  const blocked = (i: number) => {
    const t = map.tiles[i];
    if (!PASSABLE.has(t.kind)) return true;
    if (t.terrain && world.terrains.find((x) => x.id === t.terrain)?.walkable === false) return true;
    return false;
  };
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % map.width;
    const y = Math.floor(i / map.width);
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const j = ny * map.width + nx;
      if (d[j] >= 0 || blocked(j)) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  return d;
}

export interface DemoOptions {
  seed: number;
  areaIndex: number;
  /** fov radius for "visible" */
  sight?: number;
}

/** Build a GameState-shaped object for rendering only (no engine rules involved). */
export async function buildDemoState(world: WorldSpec, opts: DemoOptions): Promise<{ state: GameState; usedMapgen: boolean; error?: string }> {
  const plan = world.areas[Math.min(opts.areaIndex, world.areas.length - 1)];
  const rng = devRng(opts.seed * 7919 + opts.areaIndex);
  let map: AreaMap;
  let usedMapgen = true;
  let error: string | undefined;
  try {
    const mg = await import('../../engine/mapgen');
    // layouts mapgen does not know yet get a dev stand-in (see abstract.ts)
    const known = (mg.GENERATOR_NAMES as readonly string[] | undefined)?.includes(plan.generator) ?? true;
    const local = known ? null : abstractMap(plan.generator, plan, rng);
    map = local ?? mg.generateArea(plan, world, mg.seededRng ? mg.seededRng(opts.seed + opts.areaIndex * 101) : rng);
    if (local) error = `mapgen has no '${plan.generator}' generator yet: dev stand-in layout`;
    usedMapgen = !local;
    try {
      mg.applyAreaTerrain?.(map, plan, world, rng);
    } catch {
      /* terrain placement optional */
    }
  } catch (e) {
    error = String((e as Error)?.message ?? e);
    usedMapgen = false;
    map = abstractMap(plan.generator, plan, rng) ?? localTestMap(plan, world, rng);
  }

  const W = map.width;
  const dist = bfs(map, map.start, world);
  const occupied = new Set<number>([map.start.y * W + map.start.x]);
  const candidates: number[] = [];
  for (let i = 0; i < dist.length; i++) if (dist[i] >= 2 && dist[i] <= 7 && !map.tiles[i].terrain && map.tiles[i].kind !== 'water' && map.tiles[i].kind !== 'door') candidates.push(i);
  candidates.sort((a, b) => dist[a] - dist[b] || a - b);
  const take = (): Pos | null => {
    while (candidates.length) {
      const k = Math.floor(rng.next() * Math.min(candidates.length, 14));
      const i = candidates.splice(k, 1)[0];
      if (occupied.has(i)) continue;
      // keep some breathing room
      const x = i % W;
      const y = Math.floor(i / W);
      if ([...occupied].some((o) => Math.abs((o % W) - x) <= 0 && Math.abs(Math.floor(o / W) - y) <= 0)) continue;
      occupied.add(i);
      return { x, y };
    }
    return null;
  };

  const ps = world.player.stats;
  const mk = (id: string, defId: string, pos: Pos, hp: number, faction: ActorInstance['faction']): ActorInstance => ({
    id,
    defId,
    pos,
    hp,
    maxHp: hp,
    mp: 0,
    maxMp: 0,
    base: { str: 10, dex: 10, int: 10, ac: 10, speed: 100, sight: 7 },
    faction,
    statuses: [],
    energy: 0,
    cooldowns: {},
    ai: { alerted: false },
    tempMods: [],
  });
  const actors: ActorInstance[] = [mk('p', 'player', { ...map.start }, ps.hp, 'player')];
  const defs = [
    ...plan.placed.map((p) => p.actor),
    ...plan.actors.map((a) => a.actor),
  ];
  const unique = [...new Set(defs)];
  // show a variety: up to 7 different actors near the start
  let n = 0;
  for (const defId of unique) {
    if (n >= 7) break;
    const def = world.actors.find((a) => a.id === defId);
    if (!def) continue;
    const pos = take();
    if (!pos) break;
    const a = mk(`a${n}`, defId, pos, def.stats.hp, def.faction);
    if (n % 3 === 1) a.hp = Math.max(1, Math.round(def.stats.hp * 0.45));
    actors.push(a);
    n++;
  }
  // a couple of followers out in the remembered fog (should not be drawn)
  const items: FloorItem[] = [];
  const itemDefs = [...plan.placedItems.map((p) => p.item), ...plan.items.map((i) => i.item)];
  const uniqItems = [...new Set(itemDefs)].slice(0, 5);
  uniqItems.forEach((defId, k) => {
    const pos = take();
    if (!pos) return;
    items.push({ item: { id: `i${k}`, defId, count: 1 }, pos });
  });

  const knowledge: Record<string, ItemKnowledgeState> = {};
  const groupIdx = new Map<string, number>();
  for (const it of world.items) {
    if (it.knowledge === 'unknown' && it.appearanceGroup) {
      const pool = world.unknownAppearances[it.appearanceGroup] ?? [];
      const k = groupIdx.get(it.appearanceGroup) ?? 0;
      groupIdx.set(it.appearanceGroup, k + 1);
      knowledge[it.id] = { level: 'unknown', appearance: pool[k % Math.max(1, pool.length)], notes: [], timesUsed: 0 };
    } else knowledge[it.id] = { level: it.knowledge, notes: [], timesUsed: 0 };
  }

  const sight = opts.sight ?? world.player.sight ?? 8;
  const vis = simpleFov(map, world, map.start, sight);
  const seen = new Uint8Array(W * map.height);
  for (let i = 0; i < seen.length; i++) {
    // remembered: everything reachable within 26 steps plus the walls around it
    if (dist[i] >= 0 && dist[i] <= 26) seen[i] = 1;
  }
  for (let i = 0; i < seen.length; i++) {
    if (seen[i]) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    for (let oy = -1; oy <= 1 && !seen[i]; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= map.height) continue;
        const j = ny * W + nx;
        if (dist[j] >= 0 && dist[j] <= 26 && map.tiles[i].kind !== 'void') {
          seen[i] = 1;
          break;
        }
      }
  }
  for (const i of vis) seen[i] = 2;

  const area: AreaState = { index: opts.areaIndex, map, actors, items, seen, discoveredRegions: [], gmBudget: 0 };
  const state: GameState = {
    version: 1,
    worldId: world.meta.title,
    seed: opts.seed,
    rng: [1, 2, 3, 4],
    turn: 1,
    status: 'playing',
    area,
    player: {
      actorId: 'p',
      slots: Array.from({ length: TOTAL_SLOTS }, () => null),
      equipped: { weapon: null, armour: null, trinket: null },
      level: 1,
      xp: 0,
      perks: [],
      pendingPerkChoice: null,
      resources: {},
      currency: 0,
      sneaking: false,
    },
    knowledge,
    flags: {},
    counters: {},
    defeated: {},
    quests: [],
    log: [],
    pendingChoice: null,
    nextId: 100,
    stats: { kills: 0, itemsUsed: 0, damageDealt: 0, damageTaken: 0, areasCleared: 0 },
  };
  return { state, usedMapgen, error };
}
