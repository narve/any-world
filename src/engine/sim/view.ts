/**
 * Read-only helpers for bots: a non-cloning engine context, item profiles (what an item does, as
 * far as the player knows), path finding over the remembered map, and goal planning (which items,
 * actors, flags and counters the win condition / transition lock needs).
 *
 * Nothing here mutates the GameState it is given (tests/sim check this).
 */
import type { Amount, Condition, Effect, ItemDef, WorldSpec } from '../../schema/world';
import type { ActorInstance, GameState, PlayerId, Pos } from '../types';
import { type Ctx, indexWorld, leadOf, me, passable } from '../ctx';
import { rngFromState } from '../rng';
import { generateArea } from '../mapgen/index';
import { computeLegalActions } from '../legal';
import { evalCondition } from '../conditions';
import { getStat, maxHp, side } from '../stats';
import { isVisibleToPlayer } from '../effects';
import { PLAYER_HIT_CHANCE } from '../combat';
import type { PlayerAction } from '../types';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * An engine context over `state` without cloning it (the public API clones on every call, which
 * dominates simulation time). Only read-only engine helpers may be called with it. `playerId` is
 * the player the bot plays (default: the lead).
 */
export function botCtx(world: WorldSpec, state: GameState, playerId: PlayerId = state.party[0]): Ctx {
  return {
    world,
    ix: indexWorld(world),
    s: state,
    pid: playerId,
    rng: rngFromState(state.rng),
    events: [],
    mapGen: generateArea,
    depth: 0,
  };
}

/** legalActions without the defensive clone (same result; see tests/sim/bots.test.ts) */
export function fastLegal(ctx: Ctx): PlayerAction[] {
  return computeLegalActions(ctx);
}

export function player(ctx: Ctx): ActorInstance {
  const id = me(ctx).actorId;
  const p = ctx.s.area.actors.find((a) => a.id === id);
  if (!p) throw new Error('player actor missing');
  return p;
}

export function hpFrac(ctx: Ctx): number {
  const p = player(ctx);
  return p.hp / Math.max(1, maxHp(ctx, p));
}

export function cheb(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** living hostile actors the player can currently see */
export function visibleHostiles(ctx: Ctx): ActorInstance[] {
  return ctx.s.area.actors.filter((a) => a.hp > 0 && a.id !== me(ctx).actorId && side(ctx, a) === 'H' && isVisibleToPlayer(ctx, a));
}

/** living hostiles on tiles the player has seen at some point (remembered positions are stale, but useful for hunting) */
export function knownHostiles(ctx: Ctx): ActorInstance[] {
  const map = ctx.s.area.map;
  return ctx.s.area.actors.filter(
    (a) => a.hp > 0 && a.id !== me(ctx).actorId && side(ctx, a) === 'H' && me(ctx).seen[a.pos.y * map.width + a.pos.x] === 2,
  );
}

export function isNpc(ctx: Ctx, a: ActorInstance): boolean {
  return !!ctx.ix.actors.get(a.defId)?.npc;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function avgDice(dice: string | undefined): number {
  if (!dice) return 0;
  const m = /^(\d+)d(\d+)$/.exec(dice);
  if (!m) return 0;
  return (Number(m[1]) * (Number(m[2]) + 1)) / 2;
}

/** rough average of an Amount, assuming a stat of `statGuess` for scaled amounts */
export function avgAmount(a: Amount | undefined, statGuess = 12): number {
  if (!a) return 0;
  return (a.base ?? 0) + avgDice(a.dice) + (a.scale ? a.scale.factor * statGuess : 0);
}

// ---------------------------------------------------------------------------
// Item profiles
// ---------------------------------------------------------------------------

export interface ItemProfile {
  /** average hp restored on the user */
  heal: number;
  /** removes harmful statuses */
  cures: boolean;
  /** average damage dealt to enemies */
  damage: number;
  /** applies a harmful status to enemies (stun, root, debuff…) */
  debuff: boolean;
  /** helpful status / temporary stat boost on the user */
  buff: boolean;
  /** hurts its user (damage, harmful status, negative resource) */
  selfHarm: boolean;
  revealMap: boolean;
  /** resource id → average gain (custom resources and mp) */
  resources: Record<string, number>;
  setsFlags: string[];
  /** counter id → change */
  counters: Record<string, number>;
  teleportExit: boolean;
  /** the effect targets enemies (needs a target in range) */
  offensive: boolean;
}

function emptyProfile(): ItemProfile {
  return {
    heal: 0,
    cures: false,
    damage: 0,
    debuff: false,
    buff: false,
    selfHarm: false,
    revealMap: false,
    resources: {},
    setsFlags: [],
    counters: {},
    teleportExit: false,
    offensive: false,
  };
}

const profileCache = new WeakMap<ItemDef, ItemProfile>();

/** what an item really does when used (engine truth; callers decide whether the player knows it) */
export function itemProfile(world: WorldSpec, def: ItemDef): ItemProfile {
  const hit = profileCache.get(def);
  if (hit) return hit;
  const pr = emptyProfile();
  const act = def.onUse;
  if (act && def.useMode !== 'passive') {
    const t = act.targeting;
    const atEnemies = t.affects === 'enemies' || (t.affects === 'all' && t.shape !== 'self');
    const onSelf = t.shape === 'self' || t.affects === 'self_only' || t.affects === 'allies';
    const statuses = new Map((world.statuses ?? []).map((s) => [s.id, s]));
    pr.offensive = atEnemies && !onSelf;
    for (const e of act.effects) addEffect(pr, e, statuses, atEnemies && !onSelf);
  }
  profileCache.set(def, pr);
  return pr;
}

function addEffect(pr: ItemProfile, e: Effect, statuses: Map<string, { harmful: boolean }>, atEnemies: boolean): void {
  switch (e.type) {
    case 'damage':
      if (atEnemies) pr.damage += avgAmount(e.amount);
      else pr.selfHarm = true;
      break;
    case 'heal':
      if (!atEnemies) pr.heal += avgAmount(e.amount);
      break;
    case 'resource': {
      const v = avgAmount(e.amount);
      if (!atEnemies) {
        pr.resources[e.resource] = (pr.resources[e.resource] ?? 0) + v;
        if (v < 0) pr.selfHarm = true;
      }
      break;
    }
    case 'modify_stat':
      if (atEnemies) pr.debuff = pr.debuff || e.amount < 0;
      else if (e.amount > 0) pr.buff = true;
      else pr.selfHarm = true;
      break;
    case 'apply_status': {
      const harmful = statuses.get(e.status)?.harmful ?? false;
      if (atEnemies) pr.debuff = pr.debuff || harmful;
      else if (harmful) pr.selfHarm = true;
      else pr.buff = true;
      break;
    }
    case 'remove_status':
      if (!atEnemies) pr.cures = true;
      break;
    case 'reveal_map':
      pr.revealMap = true;
      break;
    case 'set_flag':
      if (e.value !== false) pr.setsFlags.push(e.flag);
      break;
    case 'counter':
      pr.counters[e.counter] = (pr.counters[e.counter] ?? 0) + e.add;
      break;
    case 'teleport':
      if (e.mode === 'to_exit') pr.teleportExit = true;
      break;
    case 'summon':
      if (!e.allied && !atEnemies) pr.selfHarm = true;
      break;
    default:
      break;
  }
}

/** knowledge level the player has of an item kind */
export function known(ctx: Ctx, defId: string): 'clear' | 'vague' | 'unknown' {
  return (me(ctx).knowledge[defId]?.level ?? 'clear') as 'clear' | 'vague' | 'unknown';
}

// ---------------------------------------------------------------------------
// Weapons and armour
// ---------------------------------------------------------------------------

/** expected damage per swing of a weapon item for the player (combat PLAYER_HIT_CHANCE) */
export function weaponScore(ctx: Ctx, def: ItemDef | null): number {
  const atk = def?.weapon ?? ctx.world.player.unarmed;
  const p = player(ctx);
  const statV = getStat(ctx, p, atk.accuracyStat);
  const hit = PLAYER_HIT_CHANCE;
  let dmg = avgAmount(atk.damage, statV);
  if (atk.range <= 1 && atk.accuracyStat === 'str') dmg += Math.max(0, Math.floor((getStat(ctx, p, 'str') - 10) / 2));
  // ranged weapons are worth a little more (first shots before contact)
  return hit * Math.max(1, dmg) * (atk.range > 1 ? 1.15 : 1);
}

export function armourScore(def: ItemDef | null): number {
  if (!def) return 0;
  let v = def.armour ?? 0;
  for (const m of def.modifiers) v += modValue(m.stat, m.amount);
  return v;
}

export function modValue(stat: string, amount: number): number {
  switch (stat) {
    case 'ac':
      return amount * 1.5;
    case 'hp':
      return amount * 0.4;
    case 'str':
    case 'dex':
      return amount * 0.8;
    case 'int':
      return amount * 0.5;
    case 'speed':
      return amount * 0.05;
    case 'sight':
      return amount * 0.3;
    default:
      return amount * 0.2;
  }
}

export function trinketScore(def: ItemDef | null): number {
  if (!def) return 0;
  let v = 0;
  for (const m of def.modifiers) v += modValue(m.stat, m.amount);
  return v + (def.armour ?? 0) * 1.5;
}

// ---------------------------------------------------------------------------
// Path finding over what the player knows
// ---------------------------------------------------------------------------

export interface PathField {
  /** cost from the player to each tile (Infinity = unreachable/unknown) */
  dist: Float64Array;
  /** previous tile index on the cheapest path */
  prev: Int32Array;
  width: number;
}

export interface PathOpts {
  /** extra cost per tile (hazards, tiles next to hostiles…) */
  extraCost?: (i: number) => number;
  /** walk through tiles never seen (used only as a last resort) */
  throughUnseen?: boolean;
}

const HAZARD_COST = 6;

/** per-tile hazard penalty (terrain that hurts or slows) */
export function hazardCost(ctx: Ctx, i: number): number {
  const t = ctx.s.area.map.tiles[i];
  if (!t?.terrain) return 0;
  const td = ctx.ix.terrains.get(t.terrain);
  if (!td) return 0;
  let c = (td.moveCost ?? 1) - 1;
  for (const e of td.onStand) {
    if (e.type === 'damage') c += HAZARD_COST;
    else if (e.type === 'apply_status' && ctx.ix.statuses.get(e.status)?.harmful) c += HAZARD_COST / 2;
    else if (e.type === 'resource' && avgAmount(e.amount) < 0) c += 2;
  }
  return c;
}

/**
 * Dijkstra from the player over remembered walkable tiles (8-way). Actors don't block (bumping a
 * hostile attacks it, bumping an NPC talks or swaps).
 */
export function pathField(ctx: Ctx, opts: PathOpts = {}): PathField {
  const map = ctx.s.area.map;
  const W = map.width;
  const N = W * map.height;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const seen = me(ctx).seen;
  const p = player(ctx);
  const start = p.pos.y * W + p.pos.x;
  dist[start] = 0;
  // binary heap of [cost, index]
  const heapC: number[] = [0];
  const heapI: number[] = [start];
  const push = (c: number, i: number) => {
    heapC.push(c);
    heapI.push(i);
    let k = heapC.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heapC[up] <= heapC[k]) break;
      [heapC[up], heapC[k]] = [heapC[k], heapC[up]];
      [heapI[up], heapI[k]] = [heapI[k], heapI[up]];
      k = up;
    }
  };
  const pop = (): [number, number] => {
    const c = heapC[0];
    const i = heapI[0];
    const lc = heapC.pop()!;
    const li = heapI.pop()!;
    if (heapC.length) {
      heapC[0] = lc;
      heapI[0] = li;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heapC.length && heapC[l] < heapC[m]) m = l;
        if (r < heapC.length && heapC[r] < heapC[m]) m = r;
        if (m === k) break;
        [heapC[m], heapC[k]] = [heapC[k], heapC[m]];
        [heapI[m], heapI[k]] = [heapI[k], heapI[m]];
        k = m;
      }
    }
    return [c, i];
  };
  while (heapC.length) {
    const [c, i] = pop();
    if (c > dist[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= map.height) continue;
        const j = ny * W + nx;
        if (!opts.throughUnseen && seen[j] === 0) continue;
        if (!passable(ctx, nx, ny)) continue;
        const nc = c + 1 + hazardCost(ctx, j) + (opts.extraCost ? opts.extraCost(j) : 0);
        if (nc < dist[j]) {
          dist[j] = nc;
          prev[j] = i;
          push(nc, j);
        }
      }
  }
  return { dist, prev, width: W };
}

/** first step (tile index) on the path from the player to tile `goal`, or -1 */
export function firstStep(field: PathField, goal: number, start: number): number {
  if (!Number.isFinite(field.dist[goal]) || goal === start) return -1;
  let cur = goal;
  let guard = field.dist.length;
  while (field.prev[cur] !== start && guard-- > 0) {
    cur = field.prev[cur];
    if (cur < 0) return -1;
  }
  return cur;
}

export function idxToPos(i: number, w: number): Pos {
  const x = i % w;
  return { x, y: (i - x) / w };
}

/** walkable remembered tiles next to a never-seen tile */
export function frontierTiles(ctx: Ctx): number[] {
  const map = ctx.s.area.map;
  const W = map.width;
  const H = map.height;
  const seen = me(ctx).seen;
  const out: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (seen[i] === 0 || !passable(ctx, x, y)) continue;
      let open = false;
      for (let dy = -1; dy <= 1 && !open; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (seen[ny * W + nx] === 0) {
            open = true;
            break;
          }
        }
      if (open) out.push(i);
    }
  return out;
}

/** tiles the lead player has seen in this area */
export function seenCount(state: GameState): number {
  let n = 0;
  const seen = leadOf(state).seen;
  for (let i = 0; i < seen.length; i++) if (seen[i]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Goal planning
// ---------------------------------------------------------------------------

export type Objective =
  | { kind: 'item'; item: string; count: number }
  | { kind: 'defeat'; actor: string; count: number }
  | { kind: 'flag'; flag: string }
  | { kind: 'counter'; counter: string; need: number }
  | { kind: 'area'; area: number }
  | { kind: 'wait' };

/**
 * Unmet objectives of a condition. For `any`, the branch with the fewest unmet objectives that
 * doesn't need a later area wins; `not`, stat, chance and the like contribute nothing plannable.
 */
export function unmetObjectives(ctx: Ctx, c: Condition | undefined, depth = 0): Objective[] {
  if (!c || depth > 16) return [];
  const p = player(ctx);
  if (evalConditionSafe(ctx, c, p)) return [];
  switch (c.type) {
    case 'all':
      return c.of.flatMap((x) => unmetObjectives(ctx, x, depth + 1));
    case 'any': {
      let best: Objective[] | null = null;
      let bestScore = Infinity;
      for (const x of c.of) {
        const o = unmetObjectives(ctx, x, depth + 1);
        // a branch is cheaper when it stays in this area and has fewer steps
        const later = o.some((q) => q.kind === 'area' && q.area > ctx.s.area.index);
        const score = o.length + (later ? 5 : 0) + (o.length === 0 ? 100 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = o;
        }
      }
      return best ?? [];
    }
    case 'has_item':
      return c.who === 'player' || c.who === 'self' ? [{ kind: 'item', item: c.item, count: c.count ?? 1 }] : [];
    case 'actor_defeated':
      return [{ kind: 'defeat', actor: c.actor, count: c.count ?? 1 }];
    case 'flag': {
      if (c.value === false) return [];
      // a flag set by an item with a use-condition ("on the stage, once the rival is beaten") also
      // needs that condition: plan it as part of this branch
      const extra: Objective[] = [];
      for (const def of ctx.world.items) {
        const act = def.onUse;
        if (!act?.condition || !act.effects.some((e) => e.type === 'set_flag' && e.flag === c.flag && e.value !== false)) continue;
        extra.push(...unmetObjectives(ctx, act.condition, depth + 1));
        break;
      }
      return [{ kind: 'flag', flag: c.flag }, ...extra];
    }
    case 'counter':
      if (c.cmp === 'gte' || c.cmp === 'gt' || c.cmp === 'eq') return [{ kind: 'counter', counter: c.counter, need: c.value + (c.cmp === 'gt' ? 1 : 0) }];
      return [];
    case 'in_area':
      return [{ kind: 'area', area: c.area }];
    case 'turn':
      return c.cmp === 'gte' || c.cmp === 'gt' ? [{ kind: 'wait' }] : [];
    default:
      return [];
  }
}

export function evalConditionSafe(ctx: Ctx, c: Condition, self: ActorInstance): boolean {
  try {
    // conditions with `chance` draw from ctx.rng, which is a private copy here
    return evalCondition(ctx, c, { self });
  } catch {
    return false;
  }
}

/** item ids the player wants to hold right now (goal + transition lock) */
export function wantedItems(objs: Objective[]): Set<string> {
  return new Set(objs.filter((o): o is Extract<Objective, { kind: 'item' }> => o.kind === 'item').map((o) => o.item));
}

/** actor def ids the player must defeat */
export function wantedDefeats(objs: Objective[]): Set<string> {
  return new Set(objs.filter((o): o is Extract<Objective, { kind: 'defeat' }> => o.kind === 'defeat').map((o) => o.actor));
}

/**
 * actor def ids worth defeating for their loot: hostiles in this area that drop an item the bot
 * needs, while no copy of it lies on the floor or in the pack (a lock item carried by a boss)
 */
export function lootCarriers(ctx: Ctx, wantItems: Set<string>): Set<string> {
  const out = new Set<string>();
  if (!wantItems.size) return out;
  const missing = [...wantItems].filter((id) => !ctx.s.area.items.some((fi) => fi.item.defId === id) && !me(ctx).slots.some((it) => it?.defId === id));
  if (!missing.length) return out;
  for (const a of ctx.s.area.actors) {
    if (a.hp <= 0 || a.id === me(ctx).actorId || side(ctx, a) !== 'H') continue;
    const def = ctx.ix.actors.get(a.defId);
    if (def?.loot.some((l) => l.chance > 0 && missing.includes(l.item))) out.add(a.defId);
  }
  return out;
}

/** objectives that matter now: the transition lock of this area, and the goal (filtered to this area) */
export function currentObjectives(ctx: Ctx): { goal: Objective[]; lock: Objective[]; finalArea: boolean } {
  const idx = ctx.s.area.index;
  const finalArea = idx >= ctx.world.areas.length - 1;
  const plan = ctx.world.areas[idx];
  const lock = finalArea ? [] : unmetObjectives(ctx, plan?.transitionRequires);
  const goal = unmetObjectives(ctx, ctx.world.goal.win);
  return { goal, lock, finalArea };
}

/** a lose condition counter the player should keep low (counter id → threshold) */
export function loseCounters(world: WorldSpec): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (c: Condition | undefined, depth = 0): void => {
    if (!c || depth > 16) return;
    if (c.type === 'all' || c.type === 'any') c.of.forEach((x) => walk(x, depth + 1));
    else if (c.type === 'counter' && (c.cmp === 'gte' || c.cmp === 'gt')) out.set(c.counter, c.value);
  };
  walk(world.goal.lose);
  return out;
}

/** resources whose running out hurts (drains each turn, or has on-empty effects, or is fatal) */
export function vitalResources(world: WorldSpec): string[] {
  return (world.resources ?? []).filter((r) => r.perTurn < 0 || r.emptyIsDeath || r.onEmpty.length > 0).map((r) => r.id);
}
