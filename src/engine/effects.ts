/**
 * Effects and targeting. `runAction` resolves an Action's targeting (self/single/adjacent/ray/cone/
 * area/all_visible, with range, radius, affects filter and line of sight), checks its condition
 * and applies every effect. Observations are collected so item knowledge can write notes.
 */
import type { Action, Amount, Effect, Targeting } from '../schema/world';
import type { ActorInstance, Pos, Tile } from './types';
import {
  type Ctx,
  actorAt,
  actorName,
  emit,
  endGame,
  findFreeNear,
  isAlive,
  isFree,
  isPlayer,
  log,
  logKey,
  me,
  mutTile,
  opaque,
  passable,
  playerActor,
  playerOf,
  tileWalkable,
  withPlayer,
} from './ctx';
import { END_REASON_KEYS, FACTION_KEYS, renderTemplate } from './log-keys';
import { evalCondition } from './conditions';
import { getStat, isAlly, isEnemy, maxHp, maxMp, sightRadius } from './stats';
import { applyStatus, removeStatus } from './statuses';
import { dealDamage, heal, killPlayer } from './combat';
import { makeNoise, moveActor, spawnActor, transformActor } from './actors';
import { fireTriggers } from './triggers';
import { grantXp } from './progression';
import { identifyCarried } from './knowledge';
import { dropItemAt } from './inventory';
import { hasLos } from './fov';
import { bfsDistances } from './path';
import { cheb, clamp, own, inBounds, line, samePos, tileAt } from './util';

/** something the player could observe while an action resolved (used for knowledge notes) */
export interface Obs {
  kind:
    | 'heal'
    | 'hurt'
    | 'resource'
    | 'stat'
    | 'status'
    | 'status_removed'
    | 'teleport'
    | 'moved'
    | 'summon'
    | 'terrain'
    | 'item'
    | 'reveal'
    | 'identify'
    | 'light'
    | 'noise'
    | 'xp'
    | 'faction'
    | 'transform';
  /** the player was the one affected */
  self: boolean;
  amount?: number;
  label?: string;
  who?: string;
}

export interface RunOpts {
  targetPos?: Pos;
  targetActor?: ActorInstance | null;
  /** id credited for damage/kills (defaults to the user) */
  sourceId?: string;
  obs?: Obs[];
}

export interface RunResult {
  ok: boolean;
  reason?: string;
  conditionFailed?: boolean;
  affected: ActorInstance[];
  obs: Obs[];
  centre: Pos;
}

export interface Resolved {
  ok: true;
  actors: ActorInstance[];
  centre: Pos;
  tiles: Pos[];
}

export const POSITIONAL_SHAPES = new Set<Targeting['shape']>(['single', 'ray', 'cone', 'area']);

const ACTOR_EFFECTS = new Set<Effect['type']>([
  'damage',
  'heal',
  'resource',
  'modify_stat',
  'apply_status',
  'remove_status',
  'teleport',
  'push',
  'pull',
  'transform',
  'change_faction',
  'light',
]);

export function isActorEffect(e: Effect): boolean {
  return ACTOR_EFFECTS.has(e.type);
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

export function evalAmount(ctx: Ctx, amt: Amount, source: ActorInstance | null, crit = false): number {
  let v = amt.base ?? 0;
  if (amt.dice) {
    v += ctx.rng.dice(amt.dice);
    if (crit) v += ctx.rng.dice(amt.dice);
  }
  if (amt.scale && source) v += getStat(ctx, source, amt.scale.stat) * amt.scale.factor;
  return Math.round(v);
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export function passesFilter(ctx: Ctx, user: ActorInstance, a: ActorInstance, affects: Targeting['affects']): boolean {
  switch (affects) {
    case 'self_only':
      return a === user;
    case 'enemies':
      return isEnemy(ctx, user, a);
    case 'allies':
      return isAlly(ctx, user, a);
    case 'all':
      return true;
  }
  return false;
}

const losFn = (ctx: Ctx) => (x: number, y: number) => opaque(ctx, x, y);

export function los(ctx: Ctx, a: Pos, b: Pos): boolean {
  return hasLos(a, b, losFn(ctx));
}

/** how far away a target position may be for this targeting */
export function targetingReach(t: Targeting, user?: { sight: number }): number {
  switch (t.shape) {
    case 'single':
      return Math.max(1, t.range);
    case 'ray':
      return Math.max(1, t.range);
    case 'cone':
      return Math.max(1, t.radius > 0 ? t.radius : t.range);
    case 'area':
      return Math.max(0, t.range) + Math.max(0, t.radius);
    case 'adjacent':
      return 1;
    case 'all_visible':
      return t.range > 1 ? t.range : (user?.sight ?? 8);
    default:
      return 0;
  }
}

/**
 * True when any of the effects would hurt whoever it lands on (damage, draining a resource or a
 * stat, a harmful status, a transformation or a hostile summon). Used so an "affects everyone"
 * action never aims itself at its own user.
 */
export function isHarmfulEffects(ctx: Ctx, effects: readonly Effect[]): boolean {
  return effects.some((e) => {
    switch (e.type) {
      case 'damage':
      case 'transform':
        return true;
      case 'resource':
        return (e.amount.base ?? 0) < 0 || (e.amount.scale?.factor ?? 0) < 0;
      case 'modify_stat':
        return e.amount < 0;
      case 'apply_status':
        return !!ctx.ix.statuses.get(e.status)?.harmful;
      case 'summon':
        return !e.allied;
      default:
        return false;
    }
  });
}

/**
 * Nearest actor passing the filter within reach (+LOS). The user is the fallback only when nothing
 * else fits and the action is meant for them: affects 'allies' or 'self_only', or 'all' when the
 * `effects` are known and harmless. A harmful (or unknown) "affects everyone" action with nothing
 * in range has no target, so it is never thrown at the user's own feet.
 */
export function autoTarget(ctx: Ctx, user: ActorInstance, t: Targeting, effects?: readonly Effect[]): ActorInstance | null {
  const reach = targetingReach(t, { sight: sightRadius(ctx, user) });
  let best: ActorInstance | null = null;
  let bestD = Infinity;
  for (const a of ctx.s.area.actors) {
    if (a === user || a.hp <= 0) continue;
    if (!passesFilter(ctx, user, a, t.affects)) continue;
    const d = cheb(user.pos, a.pos);
    if (d > reach) continue;
    if (t.needsLos && !los(ctx, user.pos, a.pos)) continue;
    if (isPlayer(ctx, user) && !isVisibleToPlayer(ctx, a)) continue;
    if (d < bestD) {
      best = a;
      bestD = d;
    }
  }
  if (best) return best;
  if (t.affects === 'allies' || t.affects === 'self_only') return user;
  if (t.affects === 'all' && effects && !isHarmfulEffects(ctx, effects)) return user;
  return null;
}

export function isVisibleToPlayer(ctx: Ctx, a: ActorInstance): boolean {
  const map = ctx.s.area.map;
  if (!inBounds(map, a.pos.x, a.pos.y)) return false;
  if (isPlayer(ctx, a)) return true;
  const seen = me(ctx).seen[a.pos.y * map.width + a.pos.x];
  if (seen !== 2) return false;
  const inv = a.statuses.some((s) => ctx.ix.statuses.get(s.id)?.flags.includes('invisible'));
  if (inv && cheb(a.pos, playerActor(ctx).pos) > 1) return false;
  return true;
}

function actorsOn(ctx: Ctx, tiles: Pos[]): ActorInstance[] {
  const keys = new Set(tiles.map((p) => p.y * 100000 + p.x));
  return ctx.s.area.actors.filter((a) => a.hp > 0 && keys.has(a.pos.y * 100000 + a.pos.x));
}

/** tiles of a circle (r²+r) around c that are within LOS of c */
export function circleTiles(ctx: Ctx, c: Pos, r: number, needLos = true): Pos[] {
  const map = ctx.s.area.map;
  const out: Pos[] = [];
  const rr = r * r + r;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      const p = { x: c.x + dx, y: c.y + dy };
      if (!inBounds(map, p.x, p.y)) continue;
      if (needLos && !(dx === 0 && dy === 0) && !los(ctx, c, p)) continue;
      out.push(p);
    }
  return out;
}

export function resolveTargets(
  ctx: Ctx,
  user: ActorInstance,
  t: Targeting,
  targetPos?: Pos,
  effects?: readonly Effect[],
): Resolved | { ok: false; reason: string } {
  const r = resolveShape(ctx, user, t, targetPos, effects);
  // 'self_only' filters who is affected (always the user), it never skips the shape's range and
  // line-of-sight checks: a positional "only me" action (a blink, a summon at a spot) still has
  // to reach its target position
  if (r.ok && t.affects === 'self_only') return { ...r, actors: [user] };
  return r;
}

function resolveShape(
  ctx: Ctx,
  user: ActorInstance,
  t: Targeting,
  targetPos?: Pos,
  effects?: readonly Effect[],
): Resolved | { ok: false; reason: string } {
  const map = ctx.s.area.map;
  const filt = (list: ActorInstance[], includeUser: boolean) =>
    list.filter((a) => (a !== user || includeUser) && passesFilter(ctx, user, a, t.affects));

  if (t.shape === 'self' || (t.affects === 'self_only' && !POSITIONAL_SHAPES.has(t.shape))) {
    return { ok: true, actors: [user], centre: { ...user.pos }, tiles: [{ ...user.pos }] };
  }
  // an "only me" ray or cone without an aim has nowhere to point: it acts where the user stands
  if (t.affects === 'self_only' && !targetPos && (t.shape === 'ray' || t.shape === 'cone')) {
    return { ok: true, actors: [user], centre: { ...user.pos }, tiles: [{ ...user.pos }] };
  }

  if (t.shape === 'adjacent') {
    const tiles = circleTiles(ctx, user.pos, 1, false).filter((p) => cheb(p, user.pos) <= 1);
    return { ok: true, actors: filt(actorsOn(ctx, tiles), false), centre: { ...user.pos }, tiles };
  }

  if (t.shape === 'all_visible') {
    const reach = targetingReach(t, { sight: sightRadius(ctx, user) });
    const list = ctx.s.area.actors.filter((a) => {
      if (a.hp <= 0) return false;
      if (cheb(a.pos, user.pos) > reach) return false;
      if (a !== user && t.needsLos && !los(ctx, user.pos, a.pos)) return false;
      if (a !== user && isPlayer(ctx, user) && !isVisibleToPlayer(ctx, a)) return false;
      return true;
    });
    return { ok: true, actors: filt(list, t.affects === 'allies'), centre: { ...user.pos }, tiles: [] };
  }

  // positional shapes need a target position
  let tp = targetPos;
  if (!tp) {
    const auto = autoTarget(ctx, user, t, effects);
    if (!auto) return { ok: false, reason: 'no target in range' };
    tp = auto.pos;
  }
  if (!inBounds(map, tp.x, tp.y)) return { ok: false, reason: 'target out of bounds' };
  tp = { x: tp.x, y: tp.y };

  if (t.shape === 'single') {
    if (cheb(user.pos, tp) > Math.max(1, t.range)) return { ok: false, reason: 'target out of range' };
    if (t.needsLos && !los(ctx, user.pos, tp)) return { ok: false, reason: 'no line of sight' };
    const a = actorAt(ctx, tp);
    const actors = a && passesFilter(ctx, user, a, t.affects) ? [a] : [];
    return { ok: true, actors, centre: tp, tiles: [tp] };
  }

  if (t.shape === 'ray') {
    if (samePos(tp, user.pos)) return { ok: false, reason: 'pick a direction' };
    const len = Math.max(1, t.range);
    const dx = tp.x - user.pos.x;
    const dy = tp.y - user.pos.y;
    const k = Math.ceil((len + 1) / Math.max(Math.abs(dx), Math.abs(dy)));
    const far = { x: user.pos.x + dx * k, y: user.pos.y + dy * k };
    const tiles: Pos[] = [];
    for (const p of line(user.pos, far).slice(1)) {
      if (cheb(p, user.pos) > len) break;
      if (!inBounds(map, p.x, p.y)) break;
      if (opaque(ctx, p.x, p.y) && !passable(ctx, p.x, p.y)) break;
      tiles.push(p);
      if (opaque(ctx, p.x, p.y)) break;
    }
    const centre = tiles.length ? tiles[tiles.length - 1] : { ...user.pos };
    return { ok: true, actors: filt(actorsOn(ctx, tiles), false), centre, tiles };
  }

  if (t.shape === 'cone') {
    if (samePos(tp, user.pos)) return { ok: false, reason: 'pick a direction' };
    const len = Math.max(1, t.radius > 0 ? t.radius : t.range);
    const vx = tp.x - user.pos.x;
    const vy = tp.y - user.pos.y;
    const vl = Math.hypot(vx, vy);
    const tiles: Pos[] = [];
    for (let dy = -len; dy <= len; dy++)
      for (let dx = -len; dx <= len; dx++) {
        if (dx === 0 && dy === 0) continue;
        const p = { x: user.pos.x + dx, y: user.pos.y + dy };
        if (!inBounds(map, p.x, p.y)) continue;
        if (dx * dx + dy * dy > len * len + len) continue;
        const cos = (dx * vx + dy * vy) / (Math.hypot(dx, dy) * vl);
        if (cos < 0.69) continue;
        if (t.needsLos && !los(ctx, user.pos, p)) continue;
        tiles.push(p);
      }
    return { ok: true, actors: filt(actorsOn(ctx, tiles), false), centre: tp, tiles };
  }

  // area
  if (cheb(user.pos, tp) > Math.max(0, t.range)) return { ok: false, reason: 'target out of range' };
  if (t.needsLos && !los(ctx, user.pos, tp)) return { ok: false, reason: 'no line of sight' };
  const tiles = circleTiles(ctx, tp, Math.max(0, t.radius), true);
  return { ok: true, actors: filt(actorsOn(ctx, tiles), true), centre: tp, tiles };
}

// ---------------------------------------------------------------------------
// Running actions
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with the user's player as the acting player when the user is a player actor, so the
 * `me(ctx)` reads inside an effect (fog, knowledge, xp) are the user's, never another player's.
 */
export function asUser<T>(ctx: Ctx, user: ActorInstance, fn: () => T): T {
  const ps = playerOf(ctx, user);
  return ps && ps.id !== ctx.pid ? withPlayer(ctx, ps.id, fn) : fn();
}

export function runAction(ctx: Ctx, action: Action, user: ActorInstance, opts: RunOpts = {}): RunResult {
  return asUser(ctx, user, () => runActionAs(ctx, action, user, opts));
}

function runActionAs(ctx: Ctx, action: Action, user: ActorInstance, opts: RunOpts): RunResult {
  const obs = opts.obs ?? [];
  const tr = resolveTargets(ctx, user, action.targeting, opts.targetPos ?? opts.targetActor?.pos, action.effects);
  if (!tr.ok) return { ok: false, reason: tr.reason, affected: [], obs, centre: { ...user.pos } };
  const primary = opts.targetActor ?? tr.actors.find((a) => a !== user) ?? tr.actors[0] ?? null;
  if (action.condition && !evalCondition(ctx, action.condition, { self: user, target: primary, source: user })) {
    return { ok: true, conditionFailed: true, affected: [], obs, centre: tr.centre };
  }
  if (action.vfx && action.vfx.kind !== 'none') {
    const ev: { type: 'effect'; vfx: string; from: Pos; to: Pos; color?: string; radius?: number } = {
      type: 'effect',
      vfx: action.vfx.kind,
      from: { ...user.pos },
      to: { ...tr.centre },
    };
    if (action.vfx.color) ev.color = action.vfx.color;
    if (action.targeting.shape === 'area' || action.targeting.shape === 'cone') ev.radius = action.targeting.radius;
    emit(ctx, ev);
  }
  applyEffectList(ctx, action.effects, user, tr.actors, tr.centre, obs, opts.sourceId);
  return { ok: true, affected: tr.actors, obs, centre: tr.centre };
}

/** applies effects in order: actor effects to every (still living) target, the rest once at `centre` */
export function applyEffectList(
  ctx: Ctx,
  effects: readonly Effect[],
  user: ActorInstance,
  targets: ActorInstance[],
  centre: Pos,
  obs: Obs[],
  sourceId?: string,
): void {
  asUser(ctx, user, () => {
    for (const e of effects) {
      if (ctx.s.status !== 'playing') return;
      if (isActorEffect(e)) {
        for (const t of targets) {
          if (!isAlive(ctx, t)) continue;
          applyActorEffect(ctx, e, user, t, centre, obs, sourceId);
        }
      } else {
        applyPositionalEffect(ctx, e, user, centre, obs);
      }
    }
  });
}

function credit(user: ActorInstance, target: ActorInstance, sourceId?: string): string | undefined {
  if (sourceId) return sourceId;
  return user === target ? undefined : user.id;
}

export function applyActorEffect(
  ctx: Ctx,
  e: Effect,
  user: ActorInstance,
  target: ActorInstance,
  centre: Pos,
  obs: Obs[],
  sourceId?: string,
): void {
  // "you" in item notes: the user's own player, never a teammate the effect lands on
  const self = isPlayer(ctx, target) && (target === user || !isPlayer(ctx, user));
  const who = actorName(ctx, target);
  switch (e.type) {
    case 'damage': {
      const amt = evalAmount(ctx, e.amount, user);
      const dealt = dealDamage(ctx, target, amt, e.damageType, credit(user, target, sourceId));
      obs.push({ kind: 'hurt', self, amount: dealt, who, label: e.damageType });
      return;
    }
    case 'heal': {
      const n = heal(ctx, target, evalAmount(ctx, e.amount, user));
      obs.push({ kind: 'heal', self, amount: n, who });
      return;
    }
    case 'resource': {
      const n = changeResource(ctx, target, e.resource, evalAmount(ctx, e.amount, user), credit(user, target, sourceId));
      obs.push({ kind: 'resource', self, amount: n, label: e.resource, who });
      return;
    }
    case 'modify_stat': {
      modifyStat(ctx, target, e.stat, e.amount, e.duration);
      obs.push({ kind: 'stat', self, amount: e.amount, label: e.stat, who });
      return;
    }
    case 'apply_status': {
      if (applyStatus(ctx, target, e.status, e.duration, user === target ? undefined : user.id)) obs.push({ kind: 'status', self, label: e.status, who, amount: e.duration });
      return;
    }
    case 'remove_status': {
      for (const id of removeStatus(ctx, target, e.status)) obs.push({ kind: 'status_removed', self, label: id, who });
      return;
    }
    case 'teleport': {
      const dest = teleportDestination(ctx, e.mode, user, target, centre);
      if (e.mode === 'swap') {
        if (target === user) return;
        const up = { ...user.pos };
        const tp = { ...target.pos };
        target.pos = up;
        user.pos = tp;
        emit(ctx, { type: 'moved', actorId: target.id, from: tp, to: up });
        emit(ctx, { type: 'moved', actorId: user.id, from: up, to: tp });
        obs.push({ kind: 'teleport', self: self || isPlayer(ctx, user), who });
        return;
      }
      if (!dest) return;
      moveActor(ctx, target, dest);
      obs.push({ kind: 'teleport', self, who });
      return;
    }
    case 'push':
    case 'pull': {
      if (target === user) return;
      const moved = pushPull(ctx, user, target, e.type === 'push' ? e.distance : -e.distance);
      if (moved) obs.push({ kind: 'moved', self, who, amount: moved });
      return;
    }
    case 'transform': {
      if (transformActor(ctx, target, e.into)) obs.push({ kind: 'transform', self, who, label: e.into });
      return;
    }
    case 'change_faction': {
      if (isPlayer(ctx, target)) return;
      target.faction = e.faction;
      if (e.faction === 'hostile') delete target.allyOf;
      if (e.faction !== 'hostile') {
        target.ai.alerted = false;
        delete target.ai.lastSeen;
      }
      logKey(ctx, FACTION_KEYS[e.faction], { actor: who }, e.faction === 'hostile' ? 'bad' : 'good');
      obs.push({ kind: 'faction', self, who, label: e.faction });
      return;
    }
    case 'light': {
      target.tempMods = target.tempMods.filter((m) => m.stat !== 'light');
      target.tempMods.push({ stat: 'light', amount: e.radius, turnsLeft: e.duration });
      obs.push({ kind: 'light', self, amount: e.radius });
      return;
    }
    default:
      return;
  }
}

export function applyPositionalEffect(ctx: Ctx, e: Effect, user: ActorInstance, centre: Pos, obs: Obs[]): void {
  const userIsPlayerSide = isPlayer(ctx, user) || !!user.allyOf;
  switch (e.type) {
    case 'summon': {
      let n = 0;
      for (let i = 0; i < e.count; i++) {
        const p = findFreeNear(ctx, centre, 4) ?? findFreeNear(ctx, user.pos, 6);
        if (!p) break;
        const opts: { faction?: ActorInstance['faction']; allyOf?: string; randomEnergy?: boolean } = {};
        if (e.allied) {
          // an ally's summon serves the same owner
          if (userIsPlayerSide) opts.allyOf = user.allyOf ?? user.id;
          else opts.faction = user.faction === 'player' ? 'friendly' : user.faction;
        }
        const a = spawnActor(ctx, e.actor, p, opts);
        if (!a) break;
        if (!e.allied || !userIsPlayerSide) {
          a.ai.alerted = side_isHostile(a);
          if (a.ai.alerted) a.ai.lastSeen = { ...playerActor(ctx).pos };
        }
        n++;
      }
      if (n) {
        logKey(ctx, 'log.appears', { actor: ctx.ix.actors.get(e.actor)?.name ?? e.actor }, 'warning');
        obs.push({ kind: 'summon', self: false, amount: n, label: e.actor });
      }
      return;
    }
    case 'spawn_terrain': {
      const changed = spawnTerrain(ctx, e.terrain, centre, e.radius, e.duration);
      if (changed) obs.push({ kind: 'terrain', self: false, amount: changed, label: e.terrain });
      return;
    }
    case 'spawn_item': {
      if (!ctx.ix.items.has(e.item)) return;
      dropItemAt(ctx, e.item, e.count, centre);
      obs.push({ kind: 'item', self: false, amount: e.count, label: e.item });
      return;
    }
    case 'reveal_map': {
      const map = ctx.s.area.map;
      const seen = me(ctx).seen;
      for (let y = 0; y < map.height; y++)
        for (let x = 0; x < map.width; x++) {
          if (Math.max(Math.abs(x - centre.x), Math.abs(y - centre.y)) > e.radius) continue;
          const i = y * map.width + x;
          if (seen[i] === 0 && map.tiles[i].kind !== 'void') seen[i] = 1;
        }
      obs.push({ kind: 'reveal', self: true, amount: e.radius });
      return;
    }
    case 'identify': {
      const n = identifyCarried(ctx, e.scope);
      obs.push({ kind: 'identify', self: true, amount: n });
      return;
    }
    case 'noise': {
      makeNoise(ctx, centre, e.radius);
      obs.push({ kind: 'noise', self: false, amount: e.radius });
      return;
    }
    case 'grant_xp': {
      grantXp(ctx, e.amount);
      obs.push({ kind: 'xp', self: true, amount: e.amount });
      return;
    }
    case 'currency': {
      // paid to the party whoever the effect lands on (like grant_xp): the purse is shared
      ctx.s.purse += e.amount;
      if (e.amount >= 0) logKey(ctx, 'log.currency.gain', { amount: e.amount, currency: ctx.world.vocabulary.currency }, 'loot');
      else logKey(ctx, 'log.currency.spend', { amount: -e.amount, currency: ctx.world.vocabulary.currency }, 'info');
      return;
    }
    case 'set_flag':
      ctx.s.flags[e.flag] = e.value;
      return;
    case 'counter':
      ctx.s.counters[e.counter] = (own(ctx.s.counters, e.counter) ?? 0) + e.add;
      return;
    case 'message':
      log(ctx, e.text, 'info');
      return;
    default:
      return;
  }
}

function side_isHostile(a: ActorInstance): boolean {
  return a.faction === 'hostile' && !a.allyOf;
}

// ---------------------------------------------------------------------------
// Helpers used by effects (and elsewhere)
// ---------------------------------------------------------------------------

/** change hp/mp/custom resource (or a core stat permanently); returns the actual delta */
export function changeResource(ctx: Ctx, a: ActorInstance, res: string, amount: number, sourceId?: string): number {
  if (amount === 0) return 0;
  if (res === 'hp') {
    if (amount > 0) return heal(ctx, a, amount);
    return -dealDamage(ctx, a, -amount, 'physical', sourceId, { raw: true });
  }
  if (res === 'mp') {
    const before = a.mp;
    a.mp = clamp(a.mp + amount, 0, maxMp(ctx, a));
    if (before > 0 && a.mp === 0) resourceEmptied(ctx, a, 'mp');
    return a.mp - before;
  }
  const def = ctx.ix.resources.get(res);
  if (def) {
    const ps = playerOf(ctx, a);
    if (!ps) return 0;
    const r = ps.resources;
    const before = own(r, res) ?? 0;
    r[res] = clamp(before + amount, 0, def.max);
    if (before > 0 && r[res] === 0) resourceEmptied(ctx, a, res);
    return r[res] - before;
  }
  if (['str', 'dex', 'int', 'ac', 'speed', 'sight'].includes(res)) {
    modifyStat(ctx, a, res, amount);
    return amount;
  }
  return 0;
}

/** fires onEmpty effects, on_resource_empty triggers and emptyIsDeath */
export function resourceEmptied(ctx: Ctx, a: ActorInstance, res: string): void {
  const def = ctx.ix.resources.get(res);
  if (def && isPlayer(ctx, a)) {
    logKey(ctx, 'log.resource.empty', { resource: def.name }, 'warning');
    if (def.onEmpty.length) applyEffectList(ctx, def.onEmpty, a, [a], a.pos, []);
    if (def.emptyIsDeath && ctx.s.status === 'playing') {
      const params = { resource: def.name };
      const cause = { text: renderTemplate(END_REASON_KEYS['end.loss.resource'], params), key: 'end.loss.resource' as const, params };
      if (ctx.s.party.length > 1) {
        // a party: a fall like any other (a second chance, or down), the run lost only when all are down
        killPlayer(ctx, a, undefined, cause);
        if (ctx.s.status !== 'playing' || !isAlive(ctx, a)) return;
      } else {
        a.hp = 0;
        emit(ctx, { type: 'died', actorId: a.id, defId: a.defId });
        endGame(ctx, 'lost', cause.text, cause);
        return;
      }
    }
  }
  fireTriggers(ctx, a, 'on_resource_empty', { pos: a.pos });
}

export function modifyStat(ctx: Ctx, a: ActorInstance, stat: string, amount: number, duration?: number): void {
  if (duration && duration > 0) {
    a.tempMods.push({ stat, amount, turnsLeft: duration });
    if (stat === 'hp') a.hp = Math.min(a.hp, maxHp(ctx, a));
    if (stat === 'mp') a.mp = Math.min(a.mp, maxMp(ctx, a));
    if (stat === 'hp' && amount > 0) a.hp += amount;
    return;
  }
  switch (stat) {
    case 'str':
    case 'dex':
    case 'int':
      a.base[stat] = Math.max(1, a.base[stat] + amount);
      return;
    case 'ac':
      a.base.ac = Math.max(0, a.base.ac + amount);
      return;
    case 'speed':
      a.base.speed = clamp(a.base.speed + amount, 10, 400);
      return;
    case 'sight':
      a.base.sight = clamp(a.base.sight + amount, 1, 30);
      return;
    case 'hp':
      a.maxHp = Math.max(1, a.maxHp + amount);
      a.hp = clamp(a.hp + Math.max(0, amount), 1, maxHp(ctx, a));
      return;
    case 'mp':
      a.maxMp = Math.max(0, a.maxMp + amount);
      a.mp = clamp(a.mp + Math.max(0, amount), 0, maxMp(ctx, a));
      return;
    default: {
      const def = ctx.ix.resources.get(stat);
      if (def && isPlayer(ctx, a)) changeResource(ctx, a, stat, amount);
    }
  }
}

function teleportDestination(
  ctx: Ctx,
  mode: 'random' | 'to_target' | 'swap' | 'to_exit',
  user: ActorInstance,
  target: ActorInstance,
  centre: Pos,
): Pos | null {
  const map = ctx.s.area.map;
  switch (mode) {
    case 'random': {
      const pass = (x: number, y: number) => passable(ctx, x, y);
      const dist = bfsDistances(map.width, map.height, target.pos, pass);
      const cands: Pos[] = [];
      for (let i = 0; i < dist.length; i++) {
        if (dist[i] < 4) continue;
        const x = i % map.width;
        const p = { x, y: (i - x) / map.width };
        if (isFree(ctx, p)) cands.push(p);
      }
      return cands.length ? ctx.rng.pick(cands) : null;
    }
    case 'to_exit':
      return findFreeNear(ctx, map.exit, 6);
    case 'to_target': {
      if (target !== user) return findFreeNear(ctx, user.pos, 2);
      // never into a sealed pocket: the destination must be in sight of the aimed spot and the
      // player must still be able to reach the exit from it
      const ok = (q: Pos) => (samePos(q, centre) || los(ctx, centre, q)) && (!isPlayer(ctx, target) || exitReachable(ctx, q));
      if (isFree(ctx, centre) && ok(centre)) return { ...centre };
      return findFreeNear(ctx, centre, 2, (q) => !ok(q));
    }
    default:
      return null;
  }
}

/** positive distance pushes away from `from`, negative pulls toward it; returns tiles moved */
export function pushPull(ctx: Ctx, from: ActorInstance, target: ActorInstance, distance: number): number {
  const steps = Math.abs(distance);
  const start = { ...target.pos };
  let moved = 0;
  for (let i = 0; i < steps; i++) {
    let dx = Math.sign(target.pos.x - from.pos.x);
    let dy = Math.sign(target.pos.y - from.pos.y);
    if (distance < 0) {
      dx = -dx;
      dy = -dy;
      if (cheb(target.pos, from.pos) <= 1) break;
    }
    if (dx === 0 && dy === 0) break;
    const next = { x: target.pos.x + dx, y: target.pos.y + dy };
    if (!isFree(ctx, next)) break;
    target.pos = next;
    moved++;
  }
  if (moved) {
    emit(ctx, { type: 'moved', actorId: target.id, from: start, to: { ...target.pos } });
    fireTriggers(ctx, target, 'on_enter_tile', { pos: target.pos });
  }
  return moved;
}

/**
 * Places terrain in a radius and returns the number of tiles changed. Blocking terrain never
 * disconnects the player from the exit; permanent blocking terrain (no duration) additionally never
 * cuts the player off from any tile they could reach before (so floor items, actors and anything a
 * transition lock or win condition needs stay reachable). A placement that would is rolled back.
 */
export function spawnTerrain(ctx: Ctx, terrainId: string, centre: Pos, radius: number, duration?: number): number {
  const td = ctx.ix.terrains.get(terrainId);
  if (!td) return 0;
  const map = ctx.s.area.map;
  const permanentBlock = !td.walkable && !duration;
  const reachBefore = permanentBlock ? reachableFromPlayer(ctx) : null;
  type Prev = Pick<Tile, 'terrain' | 'terrainTtl' | 'terrainUnder' | 'interacted'>;
  const changed: { i: number; prev: Prev }[] = [];
  for (const p of circleTiles(ctx, centre, radius, false)) {
    const i = p.y * map.width + p.x;
    const t0 = map.tiles[i];
    if (t0.kind !== 'floor' && t0.kind !== 'door_open') continue;
    if (!td.walkable && actorAt(ctx, p)) continue;
    if (!td.walkable && ctx.s.area.items.some((fi) => samePos(fi.pos, p))) continue;
    const t = mutTile(ctx, i);
    changed.push({ i, prev: { terrain: t.terrain, terrainTtl: t.terrainTtl, terrainUnder: t.terrainUnder, interacted: t.interacted } });
    if (duration) {
      // temporary terrain covers what is there (the permanent terrain, not an earlier temporary
      // layer) and restores it when it expires (see endRound)
      if (t.terrain && t.terrainTtl === undefined) {
        t.terrainUnder = t.interacted ? { terrain: t.terrain, interacted: true } : { terrain: t.terrain };
      }
      delete t.interacted;
      t.terrain = terrainId;
      t.terrainTtl = duration;
    } else {
      // permanent terrain replaces the tile's terrain for good (a fresh one starts unused)
      const base = t.terrainTtl === undefined ? t.terrain : t.terrainUnder?.terrain;
      const used = t.terrainTtl === undefined ? t.interacted : t.terrainUnder?.interacted;
      if (base === terrainId && used) t.interacted = true;
      else delete t.interacted;
      t.terrain = terrainId;
      delete t.terrainTtl;
      delete t.terrainUnder;
    }
  }
  if (!changed.length) return 0;
  if (!td.walkable && (!exitReachable(ctx) || (reachBefore && cutsOff(ctx, reachBefore, new Set(changed.map((c) => c.i)))))) {
    for (const c of changed) {
      const t = mutTile(ctx, c.i);
      delete t.terrain;
      delete t.terrainTtl;
      delete t.terrainUnder;
      delete t.interacted;
      Object.assign(t, Object.fromEntries(Object.entries(c.prev).filter(([, v]) => v !== undefined)));
    }
    return 0;
  }
  emit(ctx, {
    type: 'terrain_changed',
    positions: changed.map((c) => ({ x: c.i % map.width, y: Math.floor(c.i / map.width) })),
  });
  return changed.length;
}

function reachableFromPlayer(ctx: Ctx): Int32Array {
  const map = ctx.s.area.map;
  return bfsDistances(map.width, map.height, playerActor(ctx).pos, (x, y) => tileWalkable(ctx, tileAt(map, x, y)));
}

/** true when a tile reachable before (other than the changed ones) is no longer reachable */
function cutsOff(ctx: Ctx, before: Int32Array, changed: ReadonlySet<number>): boolean {
  const after = reachableFromPlayer(ctx);
  for (let i = 0; i < before.length; i++) if (before[i] >= 0 && after[i] < 0 && !changed.has(i)) return true;
  return false;
}

export function exitReachable(ctx: Ctx, from?: Pos): boolean {
  const map = ctx.s.area.map;
  const start = from ?? playerActor(ctx).pos;
  const dist = bfsDistances(map.width, map.height, start, (x, y) => tileWalkable(ctx, tileAt(map, x, y)));
  return dist[map.exit.y * map.width + map.exit.x] !== -1;
}
