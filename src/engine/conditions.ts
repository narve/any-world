/** Condition evaluation (win/lose, trigger and action conditions, transition locks, quests). */
import type { Condition } from '../schema/world';
import type { ActorInstance, PlayerId } from './types';
import { type Ctx, isAlive, playerActor, playerActorOf, playerOf } from './ctx';
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

/**
 * How a run-level evaluation quantifies over the party: 'win' (goal.win, transition locks, quest
 * completion) needs any standing player for a personal leaf, 'lose' (goal.lose) every standing one.
 */
export type PartyMode = 'win' | 'lose';

/** what evalParty found: the result, and the player whose personal leaf decided it (quest rewards) */
export interface PartyEval {
  ok: boolean;
  decider?: PlayerId;
}

/**
 * A run-level condition for the whole party, walked once and quantified per leaf (so compound
 * goals work: `all(has_item A, has_item B)` holds with A in one pack and B in another, and a
 * `chance` leaf draws once). Leaves about "self" or "the player":
 *   - has_item counts the party's packs together, down players included;
 *   - stat, has_status, on_terrain hold for any standing player ('win') or every standing player
 *     ('lose', false when nobody is standing);
 * every other leaf (flags, counters, turn, area, chance, `target`/`source`) is global, as in
 * evalCondition. `not` negates the quantified leaf. A party of one gives exactly evalCondition
 * with the player as self.
 */
export function evalParty(ctx: Ctx, c: Condition, mode: PartyMode): boolean {
  return evalPartyFull(ctx, c, mode).ok;
}

/** evalParty with the deciding player (the first one, in party order, whose personal leaf held) */
export function evalPartyFull(ctx: Ctx, c: Condition, mode: PartyMode): PartyEval {
  const out: PartyEval = { ok: false };
  out.ok = walkParty(ctx, c, mode, out, true, 0);
  return out;
}

function walkParty(ctx: Ctx, c: Condition, mode: PartyMode, out: PartyEval, positive: boolean, depth: number): boolean {
  if (depth > 32) return false;
  switch (c.type) {
    case 'all':
      return c.of.every((x) => walkParty(ctx, x, mode, out, positive, depth + 1));
    case 'any':
      return c.of.some((x) => walkParty(ctx, x, mode, out, positive, depth + 1));
    case 'not':
      return !walkParty(ctx, c.cond, mode, out, !positive, depth + 1);
    case 'has_item':
    case 'stat':
    case 'has_status':
    case 'on_terrain': {
      if (c.who !== 'self' && c.who !== 'player') return evalCondition(ctx, c, {}, depth);
      const s = ctx.s;
      const note = (pid: PlayerId) => {
        if (positive && out.decider === undefined) out.decider = pid;
      };
      if (c.type === 'has_item') {
        let n = 0;
        let first: PlayerId | undefined;
        for (const id of s.party) {
          const k = countItem(s.players[id], c.item);
          if (k > 0 && first === undefined) first = id;
          n += k;
        }
        const ok = n >= (c.count ?? 1);
        if (ok && first !== undefined) note(first);
        return ok;
      }
      const standing = s.party.filter((id) => !s.players[id].down && isAlive(ctx, playerActorOf(ctx, id)));
      const leaf = { ...c, who: 'self' as const };
      const holds = (id: PlayerId) => evalCondition(ctx, leaf, { self: playerActorOf(ctx, id) }, depth);
      if (mode === 'win') {
        const hit = standing.find(holds);
        if (hit !== undefined) note(hit);
        return hit !== undefined;
      }
      return standing.length > 0 && standing.every(holds);
    }
    default:
      return evalCondition(ctx, c, {}, depth);
  }
}
