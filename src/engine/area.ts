/**
 * Areas: entering an area (generate or inject a map), placing terrain, actors (spawn tables +
 * guaranteed placements), items (tables + placed items), carrying the party and allies along,
 * party scaling (PARTY_SCALING), the exit countdown, transition locks.
 */
import type { AreaPlan } from '../schema/world';
import { GM_BUDGET_PER_AREA } from '../schema/gm';
import type { ActorInstance, AreaMap, PlayerId, Pos } from './types';
import { type Ctx, emit, isPlayer, logKey, me, partyActors, playerActor, playerActorOf, playerOf, tileWalkable } from './ctx';
import { spawnActor } from './actors';
import { dropItemAt } from './inventory';
import { fireTriggers } from './triggers';
import { evalParty } from './conditions';
import { updateFov } from './vision';
import { bfsDistances } from './path';
import { applyAreaTerrain } from './mapgen/index';
import { PARTY_SCALING, clampPartySize, partyScaled } from './difficulty';
import { maxHp } from './stats';
import { refillFatalResources } from './combat';
import { closeStaleChoices } from './npc';
import { cheb, clone, inBounds, samePos } from './util';

const EXTRA_SPAWNS: Record<string, number> = { small: 2, medium: 4, large: 6 };
/** in a party, spawned actors keep this many tiles from every player when the map allows */
const SPAWN_KEEP_AWAY = 3;

/** makes sure a map is usable: tiles length, start/exit in bounds and marked */
export function normaliseMap(map: AreaMap): AreaMap {
  const m = clone(map);
  if (!Array.isArray(m.tiles) || m.tiles.length !== m.width * m.height) throw new Error('map tiles do not match width × height');
  if (!inBounds(m, m.start.x, m.start.y) || !inBounds(m, m.exit.x, m.exit.y)) throw new Error('map start/exit out of bounds');
  m.regions = Array.isArray(m.regions) ? m.regions : [];
  const s = m.tiles[m.start.y * m.width + m.start.x];
  if (s.kind !== 'start') s.kind = 'start';
  const e = m.tiles[m.exit.y * m.width + m.exit.x];
  if (e.kind !== 'transition') e.kind = 'transition';
  delete s.terrain;
  delete e.terrain;
  return m;
}

interface Placement {
  /** BFS distance from start (−1 unreachable) */
  fromStart: Int32Array;
  fromExit: Int32Array;
  /** reachable, unoccupied plain floor tiles (not start/exit) */
  floor: Pos[];
}

function walk(ctx: Ctx) {
  const map = ctx.s.area.map;
  return (x: number, y: number) => tileWalkable(ctx, map.tiles[y * map.width + x]);
}

function computePlacement(ctx: Ctx): Placement {
  const map = ctx.s.area.map;
  const pass = walk(ctx);
  const fromStart = bfsDistances(map.width, map.height, map.start, pass);
  const fromExit = bfsDistances(map.width, map.height, map.exit, pass);
  const floor: Pos[] = [];
  for (let i = 0; i < map.tiles.length; i++) {
    if (fromStart[i] < 0) continue;
    const t = map.tiles[i];
    if (t.kind !== 'floor' || !tileWalkable(ctx, t)) continue;
    const x = i % map.width;
    floor.push({ x, y: (i - x) / map.width });
  }
  return { fromStart, fromExit, floor };
}

function occupied(ctx: Ctx, p: Pos): boolean {
  return ctx.s.area.actors.some((a) => samePos(a.pos, p));
}

type Where = 'anywhere' | 'near_start' | 'near_exit' | 'far' | 'centre' | 'guarded';

function choosePos(ctx: Ctx, pl: Placement, where: Where, forItem = false): Pos | null {
  const map = ctx.s.area.map;
  const W = map.width;
  let free = pl.floor.filter((p) => (forItem ? !ctx.s.area.items.some((fi) => samePos(fi.pos, p)) : !occupied(ctx, p)));
  if (!free.length) return null;
  // in a party the players stand around the start: actors keep SPAWN_KEEP_AWAY tiles from all of
  // them (near_start most of all), unless nothing else is left
  if (!forItem && (ctx.s.area.partySize ?? 1) > 1) {
    const players = partyActors(ctx).map((a) => a.pos);
    const away = free.filter((p) => !players.some((q) => cheb(p, q) <= SPAWN_KEEP_AWAY));
    if (away.length) free = away;
  }
  const ds = (p: Pos) => pl.fromStart[p.y * W + p.x];
  const de = (p: Pos) => pl.fromExit[p.y * W + p.x];
  switch (where) {
    case 'near_start': {
      const c = free.filter((p) => ds(p) >= 2 && ds(p) <= 7);
      if (c.length) return ctx.rng.pick(c);
      return [...free].sort((a, b) => ds(a) - ds(b))[0];
    }
    case 'near_exit': {
      const c = free.filter((p) => de(p) >= 1 && de(p) <= 5);
      if (c.length) return ctx.rng.pick(c);
      return [...free].sort((a, b) => de(a) - de(b))[0];
    }
    case 'far': {
      const sorted = [...free].sort((a, b) => ds(b) - ds(a));
      return ctx.rng.pick(sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1))));
    }
    case 'centre': {
      const c = { x: map.width / 2, y: map.height / 2 };
      const sorted = [...free].sort((a, b) => (a.x - c.x) ** 2 + (a.y - c.y) ** 2 - ((b.x - c.x) ** 2 + (b.y - c.y) ** 2));
      return ctx.rng.pick(sorted.slice(0, Math.min(5, sorted.length)));
    }
    case 'guarded': {
      const guards = ctx.s.area.actors.filter((a) => a.faction === 'hostile' && !isPlayer(ctx, a));
      const uniques = guards.filter((a) => ctx.ix.actors.get(a.defId)?.unique);
      const pool = uniques.length ? uniques : guards;
      if (pool.length) {
        const strongest = [...pool].sort((a, b) => b.maxHp - a.maxHp)[0];
        const c = free.filter((p) => cheb(p, strongest.pos) <= 2);
        if (c.length) return ctx.rng.pick(c);
      }
      return choosePos(ctx, pl, 'far', forItem);
    }
    default: {
      const c = free.filter((p) => ds(p) >= 6);
      return ctx.rng.pick(c.length ? c : free);
    }
  }
}

function placeTerrain(ctx: Ctx, plan: AreaPlan): void {
  const map = ctx.s.area.map;
  if (map.tiles.some((t) => t.terrain)) return; // the generator already placed terrain
  if (!plan.terrain.length) return;
  try {
    applyAreaTerrain(map, plan, ctx.world, ctx.rng);
    return;
  } catch {
    for (const t of map.tiles) delete t.terrain;
  }
  placeTerrainFallback(ctx, plan);
}

/** own scatter (8-connected check) used only if mapgen's applyAreaTerrain fails */
function placeTerrainFallback(ctx: Ctx, plan: AreaPlan): void {
  const map = ctx.s.area.map;
  const pass = walk(ctx);
  for (const entry of plan.terrain) {
    const td = ctx.ix.terrains.get(entry.terrain);
    if (!td) continue;
    const pl = computePlacement(ctx);
    const cands = pl.floor.filter((p) => cheb(p, map.start) > 1 && cheb(p, map.exit) > 1);
    let n = Math.round(entry.density * cands.length);
    if (n === 0 && entry.density > 0 && cands.length) n = 1;
    ctx.rng.shuffle(cands);
    let placed = 0;
    for (const p of cands) {
      if (placed >= n) break;
      const t = map.tiles[p.y * map.width + p.x];
      if (t.terrain) continue;
      t.terrain = td.id;
      if (!td.walkable) {
        const d = bfsDistances(map.width, map.height, map.start, pass);
        if (d[map.exit.y * map.width + map.exit.x] < 0) {
          delete t.terrain;
          continue;
        }
      }
      placed++;
    }
  }
}

function placeActors(ctx: Ctx, plan: AreaPlan): void {
  const pl = computePlacement(ctx);
  for (const pa of plan.placed) {
    const p = choosePos(ctx, pl, pa.where);
    if (p) spawnActor(ctx, pa.actor, p, { randomEnergy: true, silent: true, uncapped: true });
  }
  // spawn table: every entry's minimum, then weighted extras up to the size budget
  const entries = plan.actors.filter((e) => ctx.ix.actors.has(e.actor));
  const counts = entries.map(() => 0);
  const spawnOne = (i: number): boolean => {
    const p = choosePos(ctx, pl, 'anywhere');
    if (!p) return false;
    const a = spawnActor(ctx, entries[i].actor, p, { randomEnergy: true, silent: true, uncapped: true });
    counts[i]++;
    return !!a;
  };
  // a party gets more of them: minimums, maximums and the extras scale (PARTY_SCALING.hostileCount);
  // `placed` actors (story, uniques) stay single
  const n = ctx.s.area.partySize ?? 1;
  const k = PARTY_SCALING.hostileCount;
  entries.forEach((e, i) => {
    for (let j = 0; j < partyScaled(e.min, n, k); j++) spawnOne(i);
  });
  const extra = partyScaled(EXTRA_SPAWNS[plan.size] ?? 4, n, k);
  for (let i = 0; i < extra; i++) {
    const weights = entries.map((e, j) => (counts[j] < partyScaled(Math.max(e.min, e.max), n, k) ? e.weight : 0));
    const j = ctx.rng.weighted(weights);
    if (j < 0) break;
    spawnOne(j);
  }
}

function placeItems(ctx: Ctx, plan: AreaPlan): void {
  const pl = computePlacement(ctx);
  for (const pi of plan.placedItems) {
    if (!ctx.ix.items.has(pi.item)) continue;
    const p = choosePos(ctx, pl, pi.where, true);
    if (p) dropItemAt(ctx, pi.item, 1, p);
  }
  const table = plan.items.filter((e) => ctx.ix.items.has(e.item));
  for (let i = 0, count = partyScaled(plan.itemCount, ctx.s.area.partySize ?? 1, PARTY_SCALING.itemCount); i < count; i++) {
    const k = ctx.rng.weighted(table.map((e) => e.weight));
    if (k < 0) break;
    const p = choosePos(ctx, pl, 'anywhere', true);
    if (!p) break;
    dropItemAt(ctx, table[k].item, 1, p);
  }
}

/**
 * Enters area `index`: builds the map (injected or generated, sized for the party), places the
 * acting player (the one who led the way) at the start and the rest of the party on the nearest
 * free floor, brings each player's nearby allies along next to them, populates the area (scaled
 * for the party) and fires on_area_enter with the acting player as user. Down players are pulled
 * along and arrive standing (getsUpOnArrival). A party of one places, spawns and draws from the
 * rng exactly as before parties.
 */
export function enterArea(ctx: Ctx, index: number, injected?: AreaMap): void {
  const plan = ctx.world.areas[index];
  if (!plan) throw new Error(`no area ${index}`);
  // late joiners count from the next area on
  const n = clampPartySize(ctx.s.party.length);
  const map = normaliseMap(injected ?? (n > 1 ? ctx.mapGen(plan, ctx.world, ctx.rng, { partySize: n }) : ctx.mapGen(plan, ctx.world, ctx.rng)));
  const prev = ctx.s.area;
  const player = prev?.actors.find((a) => a.id === me(ctx).actorId);
  if (!player) throw new Error('player actor missing');
  // the rest of the party comes along (party order), and every player's allies close to them
  const others: ActorInstance[] = [];
  for (const id of ctx.s.party) {
    const a = prev.actors.find((x) => x.id === ctx.s.players[id].actorId);
    if (a && a !== player) others.push(a);
  }
  const owners = [player, ...others];
  const allies: { ally: ActorInstance; owner: ActorInstance }[] = [];
  for (const a of prev?.actors ?? []) {
    if (a.hp <= 0) continue;
    const owner = owners.find((o) => a.allyOf === o.id && cheb(a.pos, o.pos) <= 4);
    if (owner) allies.push({ ally: a, owner });
  }
  player.pos = { ...map.start };
  ctx.s.area = {
    index,
    map,
    actors: [player],
    items: [],
    discoveredRegions: [],
    gmBudget: partyScaled(GM_BUDGET_PER_AREA, n, PARTY_SCALING.gmBudget),
    ...(n > 1 ? { partySize: n } : {}),
  };
  for (const id of ctx.s.party) ctx.s.players[id].seen = new Uint8Array(map.width * map.height);
  for (const o of owners) getsUpOnArrival(ctx, o);
  placeTerrain(ctx, plan);
  // teammates before allies and spawns, on the nearest free floor to the start (reachable, so
  // nobody lands behind a wall); a party of one places exactly as before
  for (const o of others) {
    const p = nearestFreeFloor(ctx, map.start) ?? { ...map.start };
    o.pos = p;
    ctx.s.area.actors.push(o);
  }
  // allies next to their owner (for a party of one the owner is on the start, as before)
  for (const { ally, owner } of allies) {
    const p = nearestFreeFloor(ctx, owner.pos);
    if (!p) continue;
    ally.pos = p;
    ally.ai.home = { ...p };
    delete ally.ai.lastSeen;
    delete ally.ai.targetId;
    ctx.s.area.actors.push(ally);
  }
  placeActors(ctx, plan);
  placeItems(ctx, plan);
  // a dialogue with someone left behind is over (parties only: a single player cannot leave mid-choice)
  closeStaleChoices(ctx);
  emit(ctx, { type: 'area_entered', index });
  logKey(ctx, 'log.area.enter', { area: ctx.world.vocabulary.area, number: index + 1, name: plan.name }, 'system');
  updateFov(ctx);
  fireTriggers(ctx, player, 'on_area_enter', { pos: player.pos });
  updateFov(ctx);
}

/**
 * A down player pulled along to a new area arrives standing at half health, with every empty fatal
 * resource refilled to half (a new area is a fresh start; a spent second chance stays spent).
 */
function getsUpOnArrival(ctx: Ctx, a: ActorInstance): void {
  const ps = playerOf(ctx, a);
  if (!ps?.down) return;
  delete ps.down;
  a.hp = Math.max(1, Math.ceil(maxHp(ctx, a) / 2));
  refillFatalResources(ctx, ps);
  emit(ctx, { type: 'revived', playerId: ps.id, actorId: a.id, helped: false });
  logKey(ctx, 'log.party.up', { player: ps.name }, 'good');
}

/** whether every standing player (but `except`) is within 1 tile of the exit */
export function partyAtExit(ctx: Ctx, except?: PlayerId): boolean {
  const exit = ctx.s.area.map.exit;
  return ctx.s.party.every((id) => {
    if (id === except || ctx.s.players[id].down) return true;
    const a = playerActorOf(ctx, id);
    return !a || a.hp <= 0 || cheb(a.pos, exit) <= 1;
  });
}

/**
 * End of round: the exit countdown counts down; at 0, or as soon as every standing player is at
 * the exit, the area change is pending (turnsLeft 0): runWorld stops and runTurn moves the party
 * on (party.ts). enterArea never runs inside endRound or runWorld.
 */
export function tickExitCountdown(ctx: Ctx): void {
  const cd = ctx.s.area.exitCountdown;
  if (!cd || cd.turnsLeft <= 0 || ctx.s.status !== 'playing') return;
  cd.turnsLeft = partyAtExit(ctx) ? 0 : cd.turnsLeft - 1;
  emit(ctx, { type: 'exit_countdown', turnsLeft: cd.turnsLeft, by: cd.by });
}

/** the exit countdown ran out (or everyone gathered at the exit): the party moves on now */
export function exitPending(ctx: Ctx): boolean {
  return ctx.s.area.exitCountdown?.turnsLeft === 0;
}

/** the nearest reachable, unoccupied plain floor tile to `from` (BFS; `from` itself excluded) */
export function nearestFreeFloor(ctx: Ctx, from: Pos): Pos | null {
  const map = ctx.s.area.map;
  const d = bfsDistances(map.width, map.height, from, walk(ctx));
  let best: Pos | null = null;
  let bd = Infinity;
  for (let i = 0; i < d.length; i++) {
    if (d[i] <= 0 || d[i] >= bd) continue;
    const x = i % map.width;
    const p = { x, y: (i - x) / map.width };
    if (map.tiles[i].kind !== 'floor' || occupied(ctx, p)) continue;
    best = p;
    bd = d[i];
  }
  return best;
}

/** null if the transition can be taken now, else a reason */
export function transitionFailure(ctx: Ctx): string | null {
  const p = playerActor(ctx);
  const map = ctx.s.area.map;
  const t = map.tiles[p.pos.y * map.width + p.pos.x];
  if (!samePos(p.pos, map.exit) && t?.kind !== 'transition') return 'not at the way onward';
  const plan = ctx.world.areas[ctx.s.area.index];
  if (ctx.s.area.index >= ctx.world.areas.length - 1) return 'there is nowhere further to go';
  // the lock is a run-level condition: the party's packs count together (evalParty)
  if (plan.transitionRequires && !evalParty(ctx, plan.transitionRequires, 'win')) return lockedReason(ctx);
  return null;
}

/** transitionFailure's reason when the current area's way onward is locked */
export function lockedReason(ctx: Ctx): string {
  return `${ctx.world.areas[ctx.s.area.index]?.transitionName ?? ''}: locked`;
}
