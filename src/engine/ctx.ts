/**
 * The mutable working context for one engine call: world (read-only), a cloned GameState that the
 * call mutates, the live RNG and the event list. Also world lookups and map predicates.
 */
import type {
  WorldSpec,
  ItemDef,
  ActorDef,
  StatusDef,
  TerrainDef,
  Perk,
  CustomResource,
  DamageType,
} from '../schema/world';
import type { ActorInstance, GameEvent, GameState, LogMessage, MapGenerator, Pos, Tile } from './types';
import type { SeededRng } from './rng';
import { inBounds, tileAt } from './util';

export interface Switches {
  durability: boolean;
  noNaturalHpRegen: boolean;
  allConsumablesUnknown: boolean;
  noLoot: boolean;
  /** sight multiplier (1 = normal) */
  darkness: number;
  violenceCounter?: string;
  permadeathMercy: boolean;
}

export interface WorldIndex {
  items: Map<string, ItemDef>;
  actors: Map<string, ActorDef>;
  statuses: Map<string, StatusDef>;
  terrains: Map<string, TerrainDef>;
  damageTypes: Map<string, DamageType>;
  perks: Map<string, Perk>;
  resources: Map<string, CustomResource>;
  switches: Switches;
}

const indexCache = new WeakMap<WorldSpec, WorldIndex>();

export function indexWorld(world: WorldSpec): WorldIndex {
  const hit = indexCache.get(world);
  if (hit) return hit;
  const sw: Switches = {
    durability: false,
    noNaturalHpRegen: false,
    allConsumablesUnknown: false,
    noLoot: false,
    darkness: 1,
    permadeathMercy: false,
  };
  for (const r of world.rules ?? []) {
    const s = r.switches ?? {};
    if (s.durability) sw.durability = true;
    if (s.noNaturalHpRegen) sw.noNaturalHpRegen = true;
    if (s.allConsumablesUnknown) sw.allConsumablesUnknown = true;
    if (s.noLoot) sw.noLoot = true;
    if (typeof s.darkness === 'number') sw.darkness = Math.min(sw.darkness, s.darkness);
    if (s.violenceCounter && !sw.violenceCounter) sw.violenceCounter = s.violenceCounter;
    if (s.permadeathMercy) sw.permadeathMercy = true;
  }
  const ix: WorldIndex = {
    items: new Map(world.items.map((i) => [i.id, i])),
    actors: new Map(world.actors.map((a) => [a.id, a])),
    statuses: new Map((world.statuses ?? []).map((s) => [s.id, s])),
    terrains: new Map((world.terrains ?? []).map((t) => [t.id, t])),
    damageTypes: new Map(world.damageTypes.map((d) => [d.id, d])),
    perks: new Map(world.player.growth.perks.map((p) => [p.id, p])),
    resources: new Map((world.resources ?? []).map((r) => [r.id, r])),
    switches: sw,
  };
  indexCache.set(world, ix);
  return ix;
}

export interface Ctx {
  world: WorldSpec;
  ix: WorldIndex;
  s: GameState;
  rng: SeededRng;
  events: GameEvent[];
  mapGen: MapGenerator;
  /** trigger recursion depth guard */
  depth: number;
}

export const MAX_LOG = 300;

export function log(ctx: Ctx, text: string, kind: LogMessage['kind'] = 'info', speaker?: string): void {
  const msg: LogMessage = { turn: ctx.s.turn, text, kind };
  if (speaker) msg.speaker = speaker;
  ctx.s.log.push(msg);
  if (ctx.s.log.length > MAX_LOG) ctx.s.log.splice(0, ctx.s.log.length - MAX_LOG);
  ctx.events.push({ type: 'message', text, kind });
}

export function emit(ctx: Ctx, ev: GameEvent): void {
  ctx.events.push(ev);
}

/** ends the run (idempotent): status, reason, title + goal text in the log, game_over event */
export function endGame(ctx: Ctx, result: 'won' | 'lost', reason: string): void {
  if (ctx.s.status !== 'playing') return;
  ctx.s.status = result;
  ctx.s.endReason = reason;
  const v = ctx.world.vocabulary;
  log(ctx, result === 'won' ? v.winTitle : v.lossTitle, result === 'won' ? 'good' : 'bad');
  log(ctx, result === 'won' ? ctx.world.goal.winText : ctx.world.goal.lossText, 'gm');
  emit(ctx, { type: 'game_over', result, reason });
}

export function nextId(ctx: Ctx, prefix: 'a' | 'i'): string {
  return `${prefix}${ctx.s.nextId++}`;
}

export function playerActor(ctx: Ctx): ActorInstance {
  const id = ctx.s.player.actorId;
  const a = ctx.s.area.actors.find((x) => x.id === id);
  if (!a) throw new Error('player actor missing from area');
  return a;
}

export function isPlayer(ctx: Ctx, a: ActorInstance | null | undefined): boolean {
  return !!a && a.id === ctx.s.player.actorId;
}

export function isAlive(ctx: Ctx, a: ActorInstance | null | undefined): a is ActorInstance {
  return !!a && a.hp > 0 && ctx.s.area.actors.includes(a);
}

export function findActor(ctx: Ctx, id: string | undefined): ActorInstance | undefined {
  if (!id) return undefined;
  return ctx.s.area.actors.find((a) => a.id === id);
}

export function actorDef(ctx: Ctx, a: ActorInstance): ActorDef | undefined {
  return ctx.ix.actors.get(a.defId);
}

export function actorName(ctx: Ctx, a: ActorInstance): string {
  if (isPlayer(ctx, a)) return ctx.world.player.name;
  return ctx.ix.actors.get(a.defId)?.name ?? a.defId;
}

export function actorAt(ctx: Ctx, p: Pos): ActorInstance | undefined {
  return ctx.s.area.actors.find((a) => a.pos.x === p.x && a.pos.y === p.y && a.hp > 0);
}

/** display name of a stat/resource using world vocabulary */
export function statName(ctx: Ctx, stat: string): string {
  const v = ctx.world.vocabulary.stats as Record<string, { name: string }>;
  if (v[stat]) return v[stat].name;
  const r = ctx.ix.resources.get(stat);
  if (r) return r.name;
  if (stat === 'speed') return 'Speed';
  if (stat === 'sight') return 'Sight';
  return stat;
}

export function damageTypeName(ctx: Ctx, id: string): string {
  return ctx.ix.damageTypes.get(id)?.name ?? id;
}

export function statusName(ctx: Ctx, id: string): string {
  return ctx.ix.statuses.get(id)?.name ?? id;
}

export function itemName(ctx: Ctx, defId: string): string {
  return ctx.ix.items.get(defId)?.name ?? defId;
}

// ---------------------------------------------------------------------------
// Map predicates
// ---------------------------------------------------------------------------

const WALKABLE_KINDS = new Set<Tile['kind']>(['floor', 'door', 'door_open', 'start', 'transition']);

export function tileWalkable(ctx: Ctx, t: Tile | undefined): boolean {
  if (!t || !WALKABLE_KINDS.has(t.kind)) return false;
  if (t.terrain) {
    const td = ctx.ix.terrains.get(t.terrain);
    if (td && td.walkable === false) return false;
  }
  return true;
}

export function passable(ctx: Ctx, x: number, y: number): boolean {
  return tileWalkable(ctx, tileAt(ctx.s.area.map, x, y));
}

export function opaque(ctx: Ctx, x: number, y: number): boolean {
  const map = ctx.s.area.map;
  if (!inBounds(map, x, y)) return true;
  const t = map.tiles[y * map.width + x];
  if (t.kind === 'wall' || t.kind === 'door') return true;
  if (t.terrain) {
    const td = ctx.ix.terrains.get(t.terrain);
    if (td?.blocksSight) return true;
  }
  return false;
}

/** passable, not a closed door and no living actor on it */
export function isFree(ctx: Ctx, p: Pos): boolean {
  const t = tileAt(ctx.s.area.map, p.x, p.y);
  if (!t || t.kind === 'door' || !tileWalkable(ctx, t)) return false;
  return !actorAt(ctx, p);
}

export function moveCost(ctx: Ctx, p: Pos): number {
  const t = tileAt(ctx.s.area.map, p.x, p.y);
  if (!t?.terrain) return 1;
  return Math.max(1, ctx.ix.terrains.get(t.terrain)?.moveCost ?? 1);
}

/** nearest free tile to `p` by increasing Chebyshev ring (p itself first) */
export function findFreeNear(ctx: Ctx, p: Pos, maxR = 8, exclude?: (q: Pos) => boolean): Pos | null {
  const map = ctx.s.area.map;
  for (let r = 0; r <= maxR; r++) {
    const ring: Pos[] = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const q = { x: p.x + dx, y: p.y + dy };
        if (!inBounds(map, q.x, q.y)) continue;
        if (!isFree(ctx, q)) continue;
        if (exclude && exclude(q)) continue;
        ring.push(q);
      }
    if (ring.length) return ctx.rng.pick(ring);
  }
  return null;
}
