/** Actor creation, movement, transformation and noise. */
import type { ActorInstance, Pos } from './types';
import { type Ctx, actorAt, actorName, emit, isPlayer, logKey, me, nextId } from './ctx';
import { side } from './stats';
import { fireTriggers } from './triggers';
import { cheb, own } from './util';
import { PARTY_SCALING, scaledHostileHp } from './difficulty';

export interface SpawnOpts {
  faction?: ActorInstance['faction'];
  allyOf?: string;
  /** stagger energy so packs don't move in lockstep */
  randomEnergy?: boolean;
  silent?: boolean;
  /**
   * Skip the per-area actor cap. Only the area's own placement (plan + spawn table, bounded by the
   * plan) passes it; summons, GM spawns and trigger spawns are always capped.
   */
  uncapped?: boolean;
}

/**
 * The most living non-player actors an area holds before summons and spawns are refused. Shipped
 * worlds peak at about 16; without a cap one actor whose own trigger summons its own kind grows
 * exponentially until the map is full (~1000 actors) and every turn costs seconds
 * (issues/M5-actor-cap-per-area.md).
 */
export const MAX_AREA_ACTORS = 60;

/** the cap of the current area: MAX_AREA_ACTORS, plus PARTY_SCALING.actorCap per extra player */
export function areaActorCap(ctx: Ctx): number {
  const n = ctx.s.area.partySize ?? 1;
  return n > 1 ? MAX_AREA_ACTORS + PARTY_SCALING.actorCap * (n - 1) : MAX_AREA_ACTORS;
}

/** living actors in the area other than the player */
export function livingNonPlayerActors(ctx: Ctx): number {
  let n = 0;
  for (const a of ctx.s.area.actors) if (a.hp > 0 && !isPlayer(ctx, a)) n++;
  return n;
}

/** whether the area has room for one more runtime spawn (see MAX_AREA_ACTORS, areaActorCap) */
export function areaHasRoom(ctx: Ctx): boolean {
  return livingNonPlayerActors(ctx) < areaActorCap(ctx);
}

export function makeActor(ctx: Ctx, defId: string, pos: Pos, opts: SpawnOpts = {}): ActorInstance | null {
  const def = ctx.ix.actors.get(defId);
  if (!def) return null;
  const a: ActorInstance = {
    id: nextId(ctx, 'a'),
    defId,
    pos: { x: pos.x, y: pos.y },
    hp: def.stats.hp,
    maxHp: def.stats.hp,
    mp: def.stats.mp,
    maxMp: def.stats.mp,
    base: { str: def.stats.str, dex: def.stats.dex, int: def.stats.int, ac: def.stats.ac, speed: def.speed, sight: def.sight },
    faction: opts.faction ?? def.faction,
    statuses: [],
    energy: opts.randomEnergy ? ctx.rng.int(0, 99) : 0,
    cooldowns: {},
    ai: { alerted: false, home: { x: pos.x, y: pos.y } },
    tempMods: [],
  };
  if (opts.allyOf) a.allyOf = opts.allyOf;
  else if (a.faction === 'friendly' && def.behaviour.type === 'follower') a.allyOf = me(ctx).actorId;
  if (a.allyOf) a.faction = 'friendly';
  // difficulty: hostiles (not NPCs) are tougher or frailer, uniques tougher still (engine/difficulty.ts)
  if (a.faction === 'hostile') a.hp = a.maxHp = scaledHostileHp(ctx.s, def);
  return a;
}

/**
 * Whether a unique actor may be spawned now: at most one alive at a time (in the current area, the
 * only live one) and never again once defeated. A unique spawned in an earlier area and left behind
 * there (areas are dropped on transition) can therefore appear again where a later plan places it,
 * so a win or lock that needs it stays reachable.
 */
export function uniqueSpawnable(ctx: Ctx, defId: string): boolean {
  if ((own(ctx.s.defeated, defId) ?? 0) > 0) return false;
  return !ctx.s.area.actors.some((a) => a.hp > 0 && defChain(a).includes(defId));
}

/** every def id this instance has been, its current one last (see ActorInstance.formerDefIds) */
export function defChain(a: ActorInstance): string[] {
  const out: string[] = [];
  for (const id of [...(a.formerDefIds ?? []), a.defId]) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * creates and places an actor; respects `unique` (one alive at a time, never after its defeat) and,
 * unless `opts.uncapped`, the per-area cap (MAX_AREA_ACTORS): a full area gets no new actor (null)
 */
export function spawnActor(ctx: Ctx, defId: string, pos: Pos, opts: SpawnOpts = {}): ActorInstance | null {
  const def = ctx.ix.actors.get(defId);
  if (!def) return null;
  if (actorAt(ctx, pos)) return null;
  if (!opts.uncapped && !areaHasRoom(ctx)) return null;
  if (def.unique) {
    if (!uniqueSpawnable(ctx, defId)) return null;
    const spawned = (ctx.s.uniquesSpawned ??= []);
    if (!spawned.includes(defId)) spawned.push(defId);
  }
  const a = makeActor(ctx, defId, pos, opts);
  if (!a) return null;
  ctx.s.area.actors.push(a);
  if (!opts.silent) emit(ctx, { type: 'spawned', actorId: a.id, defId });
  return a;
}

/** moves an actor (no validation) and fires its on_enter_tile triggers */
export function moveActor(ctx: Ctx, a: ActorInstance, to: Pos, fireEnter = true): void {
  const from = { x: a.pos.x, y: a.pos.y };
  if (from.x === to.x && from.y === to.y) return;
  a.pos = { x: to.x, y: to.y };
  emit(ctx, { type: 'moved', actorId: a.id, from, to: { x: to.x, y: to.y } });
  if (fireEnter) fireTriggers(ctx, a, 'on_enter_tile', { pos: to });
}

export function transformActor(ctx: Ctx, a: ActorInstance, into: string): boolean {
  if (isPlayer(ctx, a)) return false;
  const def = ctx.ix.actors.get(into);
  if (!def) return false;
  const oldName = actorName(ctx, a);
  if (a.defId !== into) {
    const former = (a.formerDefIds ??= []);
    if (!former.includes(a.defId)) former.push(a.defId);
  }
  a.defId = into;
  a.hp = a.faction === 'hostile' && !a.allyOf ? scaledHostileHp(ctx.s, def) : def.stats.hp;
  a.maxHp = a.hp;
  a.mp = def.stats.mp;
  a.maxMp = def.stats.mp;
  a.base = { str: def.stats.str, dex: def.stats.dex, int: def.stats.int, ac: def.stats.ac, speed: def.speed, sight: def.sight };
  a.cooldowns = {};
  a.ai.lowHp = false;
  if (!a.allyOf) a.faction = def.faction;
  emit(ctx, { type: 'spawned', actorId: a.id, defId: into });
  logKey(ctx, 'log.transform', { actor: oldName, into: def.name }, 'combat');
  return true;
}

/** noise alerts hostile (and provoked) actors in radius */
export function makeNoise(ctx: Ctx, pos: Pos, radius: number): void {
  emit(ctx, { type: 'noise', pos: { x: pos.x, y: pos.y }, radius });
  for (const a of ctx.s.area.actors) {
    if (isPlayer(ctx, a) || side(ctx, a) !== 'H') continue;
    if (cheb(a.pos, pos) > radius) continue;
    const def = ctx.ix.actors.get(a.defId);
    if (def?.behaviour.type === 'idle' || def?.behaviour.type === 'stationary') continue;
    a.ai.alerted = true;
    a.ai.lastSeen = { x: pos.x, y: pos.y };
  }
}
