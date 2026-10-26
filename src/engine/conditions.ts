/** Condition evaluation (win/lose, trigger and action conditions, transition locks, quests). */
import type { Condition } from '../schema/world';
import type { ActorInstance } from './types';
import { type Ctx, playerActor, playerOf } from './ctx';
import { getMax, getStat } from './stats';
import { countItem } from './inventory';
import { own, tileAt } from './util';

export interface CondCtx {
  self?: ActorInstance | null;
  target?: ActorInstance | null;
  source?: ActorInstance | null;
}

type Cmp = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

export function compare(a: number, cmp: Cmp, b: number): boolean {
  switch (cmp) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'eq':
      return a === b;
    case 'gte':
      return a >= b;
    case 'gt':
      return a > b;
  }
  return false;
}

function who(ctx: Ctx, w: 'self' | 'target' | 'player' | 'source', cc: CondCtx): ActorInstance | null {
  switch (w) {
    case 'self':
      return cc.self ?? playerActor(ctx);
    case 'target':
      return cc.target ?? null;
    case 'player':
      return playerActor(ctx);
    case 'source':
      return cc.source ?? cc.self ?? null;
  }
  return null;
}

/**
 * Evaluates a condition. `stat` with asPercentOfMax compares a 0–100 percentage
 * (values ≤ 1 are read as fractions, so 0.3 and 30 both mean 30%).
 */
export function evalCondition(ctx: Ctx, c: Condition, cc: CondCtx = {}, depth = 0): boolean {
  if (depth > 32) return false;
  switch (c.type) {
    case 'all':
      return c.of.every((x) => evalCondition(ctx, x, cc, depth + 1));
    case 'any':
      return c.of.some((x) => evalCondition(ctx, x, cc, depth + 1));
    case 'not':
      return !evalCondition(ctx, c.cond, cc, depth + 1);
    case 'stat': {
      const a = who(ctx, c.who, cc);
      if (!a) return false;
      let v = getStat(ctx, a, c.stat);
      let target = c.value;
      if (c.asPercentOfMax) {
        const m = getMax(ctx, a, c.stat);
        v = m > 0 ? (v / m) * 100 : 0;
        if (Math.abs(target) <= 1) target *= 100;
      }
      return compare(v, c.cmp, target);
    }
    case 'has_item': {
      const a = who(ctx, c.who, cc);
      const ps = playerOf(ctx, a);
      if (!ps) return false;
      return countItem(ps, c.item) >= (c.count ?? 1);
    }
    case 'has_status': {
      const a = who(ctx, c.who, cc);
      return !!a && a.statuses.some((s) => s.id === c.status);
    }
    case 'flag':
      return (own(ctx.s.flags, c.flag) ?? false) === (c.value ?? true);
    case 'counter':
      return compare(own(ctx.s.counters, c.counter) ?? 0, c.cmp, c.value);
    case 'actor_defeated':
      return (own(ctx.s.defeated, c.actor) ?? 0) >= (c.count ?? 1);
    case 'in_area':
      return ctx.s.area.index === c.area;
    case 'turn':
      return compare(ctx.s.turn, c.cmp, c.value);
    case 'on_terrain': {
      const a = who(ctx, c.who, cc);
      if (!a) return false;
      return tileAt(ctx.s.area.map, a.pos.x, a.pos.y)?.terrain === c.terrain;
    }
    case 'chance':
      return ctx.rng.chance(c.p);
    case 'always':
      return true;
  }
  return false;
}
