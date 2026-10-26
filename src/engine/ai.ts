/**
 * Non-player actor behaviour. Hostiles perceive player-side actors (sight, LOS, sneaking, invisible),
 * use abilities per `useWhen`, then act by behaviour type. Allies/followers fight hostiles and
 * follow the player. Neutral/friendly actors don't attack unless provoked (they turn hostile).
 */
import type { ActorDef } from '../schema/world';
import type { ActorInstance, Pos } from './types';
import {
  type Ctx,
  actorDef,
  actorName,
  emit,
  isAlive,
  isFree,
  isPlayer,
  logKey,
  moveCost,
  mutTile,
  passable,
  playerActor,
  playerOf,
} from './ctx';
import { getStat, hasFlag, isAlly, isEnemy, maxHp, side, sightRadius } from './stats';
import { attackOf, inAttackRange, performAttack } from './combat';
import { POSITIONAL_SHAPES, changeResource, los, resolveTargets, runAction, targetingReach } from './effects';
import { moveActor } from './actors';
import { findPath } from './path';
import { withinRadius, withinReach } from './fov';
import { playerSeesTile } from './vision';
import { DIR_LIST, DIRS, cheb, dist2, own, samePos, tileAt } from './util';


/** perception radius of `a` for `target` */
export function noticeRadius(ctx: Ctx, a: ActorInstance, target: ActorInstance): number {
  let r = sightRadius(ctx, a);
  if (playerOf(ctx, target)?.sneaking && !a.ai.alerted) r = Math.max(1, Math.ceil(r / 2));
  if (hasFlag(ctx, target, 'invisible')) r = 1;
  return r;
}

export function canPerceive(ctx: Ctx, a: ActorInstance, target: ActorInstance, radius?: number): boolean {
  const r = radius ?? noticeRadius(ctx, a, target);
  // the same circle the player's own field of view uses (computeFov), not a square
  if (!withinRadius(a.pos, target.pos, r)) return false;
  return los(ctx, a.pos, target.pos);
}

function nearestEnemy(ctx: Ctx, a: ActorInstance, radiusFor: (t: ActorInstance) => number): ActorInstance | null {
  let best: ActorInstance | null = null;
  let bd = Infinity;
  for (const t of ctx.s.area.actors) {
    if (t === a || t.hp <= 0 || !isEnemy(ctx, a, t)) continue;
    if (!canPerceive(ctx, a, t, radiusFor(t))) continue;
    const d = dist2(a.pos, t.pos);
    if (d < bd) {
      best = t;
      bd = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Movement helpers (return extra energy cost, or -1 if nothing happened)
// ---------------------------------------------------------------------------

function tryMoveTo(ctx: Ctx, a: ActorInstance, p: Pos): number {
  if (hasFlag(ctx, a, 'rooted')) return -1;
  const map = ctx.s.area.map;
  const t = tileAt(map, p.x, p.y);
  if (!t || !passable(ctx, p.x, p.y)) return -1;
  if (t.kind === 'door') {
    mutTile(ctx, p.y * map.width + p.x).kind = 'door_open';
    emit(ctx, { type: 'terrain_changed', positions: [{ ...p }] });
    return 0;
  }
  if (!isFree(ctx, p)) return -1;
  moveActor(ctx, a, p);
  return Math.round((moveCost(ctx, p) - 1) * 100);
}

export function stepToward(ctx: Ctx, a: ActorInstance, goal: Pos): number {
  if (samePos(a.pos, goal)) return -1;
  const map = ctx.s.area.map;
  const blocked = (x: number, y: number) => ctx.s.area.actors.some((o) => o !== a && o.hp > 0 && o.pos.x === x && o.pos.y === y);
  const path = findPath(map.width, map.height, a.pos, goal, (x, y) => passable(ctx, x, y) && !blocked(x, y), {
    goalAlwaysPassable: true,
    maxNodes: 1200,
  });
  if (path && path.length) {
    const next = path[0];
    if (!(samePos(next, goal) && blocked(next.x, next.y))) {
      const c = tryMoveTo(ctx, a, next);
      if (c >= 0) return c;
    }
  }
  // greedy fallback
  const here = dist2(a.pos, goal);
  const opts = DIR_LIST.map((d) => ({ x: a.pos.x + DIRS[d][0], y: a.pos.y + DIRS[d][1] }))
    .filter((p) => dist2(p, goal) < here)
    .sort((p, q) => dist2(p, goal) - dist2(q, goal));
  for (const p of opts) {
    const c = tryMoveTo(ctx, a, p);
    if (c >= 0) return c;
  }
  return -1;
}

export function stepAway(ctx: Ctx, a: ActorInstance, from: Pos): number {
  const here = dist2(a.pos, from);
  const opts = DIR_LIST.map((d) => ({ x: a.pos.x + DIRS[d][0], y: a.pos.y + DIRS[d][1] }))
    .filter((p) => dist2(p, from) > here && isFree(ctx, p))
    .sort((p, q) => dist2(q, from) - dist2(p, from));
  for (const p of opts) {
    const c = tryMoveTo(ctx, a, p);
    if (c >= 0) return c;
  }
  return -1;
}

export function randomStep(ctx: Ctx, a: ActorInstance): number {
  const d = ctx.rng.pick(DIR_LIST);
  return tryMoveTo(ctx, a, { x: a.pos.x + DIRS[d][0], y: a.pos.y + DIRS[d][1] });
}

function wander(ctx: Ctx, a: ActorInstance): number {
  const map = ctx.s.area.map;
  if (!a.ai.wander || samePos(a.ai.wander, a.pos) || ctx.rng.chance(0.05)) {
    for (let i = 0; i < 8; i++) {
      const p = { x: a.pos.x + ctx.rng.int(-8, 8), y: a.pos.y + ctx.rng.int(-8, 8) };
      if (p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height && passable(ctx, p.x, p.y)) {
        a.ai.wander = p;
        break;
      }
    }
  }
  if (!a.ai.wander) return randomStep(ctx, a);
  const c = stepToward(ctx, a, a.ai.wander);
  if (c < 0) delete a.ai.wander;
  return c;
}

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

function tryAbility(ctx: Ctx, a: ActorInstance, def: ActorDef, target: ActorInstance | null): boolean {
  if (!def.abilities.length || hasFlag(ctx, a, 'silenced')) return false;
  for (const ab of def.abilities) {
    if ((own(a.cooldowns, ab.id) ?? 0) > 0) continue;
    if (ab.cost && ab.cost.amount > 0 && getStat(ctx, a, ab.cost.resource) < ab.cost.amount) continue;
    const t = ab.action.targeting;
    const reach = targetingReach(t, { sight: sightRadius(ctx, a) });
    let targetPos: Pos | undefined;
    let ok = false;
    let p = 1;
    const hurtAlly = () =>
      ctx.s.area.actors.find(
        (o) => o.hp > 0 && isAlly(ctx, a, o) && o.hp < maxHp(ctx, o) * 0.6 && cheb(o.pos, a.pos) <= Math.max(reach, 1) && los(ctx, a.pos, o.pos),
      );
    switch (ab.useWhen) {
      case 'always':
        ok = true;
        p = 0.35;
        break;
      case 'target_in_range':
        ok = !!target && withinReach(a.pos, target.pos, Math.max(1, reach)) && los(ctx, a.pos, target.pos);
        p = 0.55;
        break;
      case 'low_hp':
        ok = a.hp < maxHp(ctx, a) * 0.4;
        break;
      case 'ally_hurt': {
        const al = hurtAlly();
        ok = !!al;
        if (al) targetPos = al.pos;
        break;
      }
      case 'start_of_fight':
        ok = !!target && own(a.cooldowns, ab.id) === undefined;
        break;
    }
    if (!ok) continue;
    // where to aim
    const offensive = t.affects === 'enemies' || t.affects === 'all';
    if (POSITIONAL_SHAPES.has(t.shape) && t.affects !== 'self_only') {
      if (!targetPos) {
        if (offensive) {
          if (!target) continue;
          targetPos = target.pos;
        } else targetPos = hurtAlly()?.pos ?? a.pos;
      }
    } else if (offensive && (t.shape === 'adjacent' || t.shape === 'all_visible')) {
      if (!target) continue;
      if (t.shape === 'adjacent' && cheb(target.pos, a.pos) > 1) continue;
    }
    if (!ctx.rng.chance(p)) continue;
    const tr = resolveTargets(ctx, a, t, targetPos, ab.action.effects);
    if (!tr.ok) continue;
    if (offensive && t.affects === 'enemies' && t.shape !== 'self' && !tr.actors.length && ab.useWhen === 'target_in_range') continue;
    // symmetric perception: a hostile never hits the player from beyond arm's reach while standing
    // somewhere the player cannot see
    if (side(ctx, a) === 'H' && offensive && tr.actors.some((x) => isPlayer(ctx, x)) && cheb(a.pos, playerActor(ctx).pos) > 1 && !playerSeesTile(ctx, a.pos)) continue;
    if (ab.cost && ab.cost.amount > 0) changeResource(ctx, a, ab.cost.resource, -ab.cost.amount);
    a.cooldowns[ab.id] = ab.cooldown;
    logKey(ctx, 'log.ability', { actor: actorName(ctx, a), ability: ab.name }, 'combat');
    runAction(ctx, ab.action, a, { targetPos, targetActor: target });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function approachAttack(ctx: Ctx, a: ActorInstance, target: ActorInstance): number {
  const atk = attackOf(ctx, a);
  if (atk && inAttackRange(ctx, a, target, atk.attack)) {
    performAttack(ctx, a, target, atk);
    return 0;
  }
  if (!atk) return -1;
  return stepToward(ctx, a, target.pos);
}

function kite(ctx: Ctx, a: ActorInstance, target: ActorInstance, pref: number): number {
  const atk = attackOf(ctx, a);
  if (!atk || atk.attack.range <= 1) return approachAttack(ctx, a, target); // nothing to kite with
  const d = cheb(a.pos, target.pos);
  if (d < pref && !hasFlag(ctx, a, 'rooted')) {
    const c = stepAway(ctx, a, target.pos);
    if (c >= 0) return c;
  }
  if (atk && inAttackRange(ctx, a, target, atk.attack)) {
    performAttack(ctx, a, target, atk);
    return 0;
  }
  return stepToward(ctx, a, target.pos);
}

function alertPack(ctx: Ctx, a: ActorInstance, target: ActorInstance): void {
  for (const o of ctx.s.area.actors) {
    if (o === a || o.defId !== a.defId || o.ai.alerted || side(ctx, o) !== 'H') continue;
    if (cheb(o.pos, a.pos) > 8) continue;
    o.ai.alerted = true;
    o.ai.lastSeen = { ...target.pos };
  }
}

function hostileTurn(ctx: Ctx, a: ActorInstance, def: ActorDef): number {
  const b = def.behaviour;
  let target: ActorInstance | null = null;
  if (b.type === 'idle') {
    if (a.ai.alerted) target = nearestEnemy(ctx, a, () => sightRadius(ctx, a));
  } else if (b.type === 'ambusher' && !a.ai.alerted) {
    const r = Math.max(1, Math.round(b.param ?? 2));
    target = nearestEnemy(ctx, a, (t) => Math.min(r, noticeRadius(ctx, a, t)));
  } else if (b.type === 'guardian') {
    const home = a.ai.home ?? a.pos;
    const r = Math.max(1, Math.round(b.param ?? 5));
    const t = nearestEnemy(ctx, a, (x) => noticeRadius(ctx, a, x));
    target = t && cheb(t.pos, home) <= r + 1 ? t : null;
  } else {
    target = nearestEnemy(ctx, a, (t) => noticeRadius(ctx, a, t));
  }
  if (target) {
    const wasAlerted = a.ai.alerted;
    a.ai.alerted = true;
    a.ai.lastSeen = { ...target.pos };
    if (!wasAlerted && b.type === 'pack') alertPack(ctx, a, target);
  }
  if (hasFlag(ctx, a, 'charmed')) return ctx.rng.chance(0.5) ? randomStep(ctx, a) : -1;
  const threat = target?.pos ?? a.ai.lastSeen ?? null;
  if (hasFlag(ctx, a, 'afraid') && threat) {
    const c = stepAway(ctx, a, threat);
    if (c >= 0) return c;
    if (target && cheb(a.pos, target.pos) <= 1) return approachAttack(ctx, a, target); // cornered
    return -1;
  }
  if (hasFlag(ctx, a, 'confused') && ctx.rng.chance(0.5)) return randomStep(ctx, a);
  if (b.erratic > 0 && ctx.rng.chance(b.erratic)) return randomStep(ctx, a);
  if (tryAbility(ctx, a, def, target)) return 0;

  if (target) {
    switch (b.type) {
      case 'kiter':
        return kite(ctx, a, target, Math.max(2, Math.round(b.param ?? 3)));
      case 'coward': {
        const frac = b.param ?? 0.3;
        if (a.hp < maxHp(ctx, a) * Math.min(1, Math.max(0, frac))) {
          a.ai.fleeing = true;
          const c = stepAway(ctx, a, target.pos);
          if (c >= 0) return c;
        } else a.ai.fleeing = false;
        return approachAttack(ctx, a, target);
      }
      case 'stationary': {
        const atk = attackOf(ctx, a);
        if (atk && inAttackRange(ctx, a, target, atk.attack)) {
          performAttack(ctx, a, target, atk);
          return 0;
        }
        return -1;
      }
      case 'guardian': {
        const home = a.ai.home ?? a.pos;
        const r = Math.max(1, Math.round(b.param ?? 5));
        if (cheb(target.pos, home) <= r + 1) return approachAttack(ctx, a, target);
        return stepToward(ctx, a, home);
      }
      default:
        return approachAttack(ctx, a, target);
    }
  }
  // no target in view
  if (b.type === 'stationary') return -1;
  if (b.type === 'guardian') {
    const home = a.ai.home;
    if (home && !samePos(home, a.pos)) return stepToward(ctx, a, home);
    return -1;
  }
  if (a.ai.lastSeen) {
    if (samePos(a.ai.lastSeen, a.pos) || stepToward(ctx, a, a.ai.lastSeen) < 0) {
      delete a.ai.lastSeen;
      a.ai.alerted = false;
      return -1;
    }
    return 0;
  }
  if (b.type === 'wanderer') return wander(ctx, a);
  return -1;
}

function passiveTurn(ctx: Ctx, a: ActorInstance, def: ActorDef): number {
  const b = def.behaviour;
  if (hasFlag(ctx, a, 'confused') && ctx.rng.chance(0.5)) return randomStep(ctx, a);
  if (b.type === 'coward') {
    const threat = ctx.s.area.actors.find((o) => o.hp > 0 && side(ctx, o) === 'H' && cheb(o.pos, a.pos) <= 3);
    if (threat) return stepAway(ctx, a, threat.pos);
  }
  if (b.type === 'wanderer' && ctx.rng.chance(0.5)) return wander(ctx, a);
  if (b.erratic > 0 && b.type !== 'stationary' && ctx.rng.chance(b.erratic * 0.5)) return randomStep(ctx, a);
  return -1;
}

function allyTurn(ctx: Ctx, a: ActorInstance, def: ActorDef): number {
  const pl = playerActor(ctx);
  const leash = Math.max(1, Math.round(def.behaviour.type === 'follower' ? (def.behaviour.param ?? 2) : 2));
  if (hasFlag(ctx, a, 'confused') && ctx.rng.chance(0.5)) return randomStep(ctx, a);
  const target = nearestEnemy(ctx, a, () => sightRadius(ctx, a));
  if (target && cheb(a.pos, pl.pos) <= 8 && !hasFlag(ctx, a, 'afraid')) {
    if (tryAbility(ctx, a, def, target)) return 0;
    const c = approachAttack(ctx, a, target);
    if (c >= 0) return c;
  } else if (tryAbility(ctx, a, def, null)) return 0;
  if (cheb(a.pos, pl.pos) > leash) return stepToward(ctx, a, pl.pos);
  return -1;
}

/** one action for a non-player actor; returns extra energy cost (≥0) */
export function actorTurn(ctx: Ctx, a: ActorInstance): number {
  if (!isAlive(ctx, a) || isPlayer(ctx, a)) return 0;
  if (hasFlag(ctx, a, 'stunned')) return 0;
  const def = actorDef(ctx, a);
  if (!def) return 0;
  let c: number;
  if (a.allyOf) c = allyTurn(ctx, a, def);
  else if (side(ctx, a) === 'H') c = hostileTurn(ctx, a, def);
  else c = passiveTurn(ctx, a, def);
  return Math.max(0, c);
}
