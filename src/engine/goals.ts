/**
 * What the run's progress depends on: the conditions that move the player forward (the goal, the
 * locks of the ways onward, active quests) and the items, actors, flags and counters they name.
 * Used by legalActions (attacks on non-hostiles whose defeat is required), the trader's buy list
 * (never buy a progress item) and the GM context.
 */
import type { Condition } from '../schema/world';
import type { Ctx } from './ctx';

/** the references of a condition tree */
export interface ConditionRefs {
  /** item def ids named by has_item (any polarity) */
  items: Set<string>;
  /** actor def id → defeat count required, from actor_defeated in positive positions only */
  defeats: Map<string, number>;
  flags: Set<string>;
  counters: Set<string>;
  statuses: Set<string>;
}

export function emptyRefs(): ConditionRefs {
  return { items: new Set(), defeats: new Map(), flags: new Set(), counters: new Set(), statuses: new Set() };
}

/** collects the references of `c` into `out` (`positive` = not under an odd number of `not`s) */
export function collectRefs(c: Condition | undefined, out: ConditionRefs, positive = true, depth = 0): ConditionRefs {
  if (!c || typeof c !== 'object' || depth > 32) return out;
  switch (c.type) {
    case 'all':
    case 'any':
      for (const x of c.of ?? []) collectRefs(x, out, positive, depth + 1);
      break;
    case 'not':
      collectRefs(c.cond, out, !positive, depth + 1);
      break;
    case 'has_item':
      out.items.add(c.item);
      break;
    case 'actor_defeated':
      if (positive) out.defeats.set(c.actor, Math.max(out.defeats.get(c.actor) ?? 0, c.count ?? 1));
      break;
    case 'flag':
      out.flags.add(c.flag);
      break;
    case 'counter':
      out.counters.add(c.counter);
      break;
    case 'has_status':
      out.statuses.add(c.status);
      break;
    default:
      break;
  }
  return out;
}

/**
 * The conditions that move the run forward from here: the win condition, the locks of the current
 * and later areas' ways onward, and the active quests.
 */
export function progressConditions(ctx: Ctx): Condition[] {
  const out: Condition[] = [ctx.world.goal.win];
  for (let i = Math.max(0, ctx.s.area.index); i < ctx.world.areas.length; i++) {
    const req = ctx.world.areas[i].transitionRequires;
    if (req) out.push(req);
  }
  for (const q of ctx.s.quests) if (q.status === 'active') out.push(q.complete);
  return out;
}

/** references of every progress condition (plus the loss condition's flags and counters) */
export function progressRefs(ctx: Ctx): ConditionRefs {
  const out = emptyRefs();
  for (const c of progressConditions(ctx)) collectRefs(c, out);
  if (ctx.world.goal.lose) {
    const lose = collectRefs(ctx.world.goal.lose, emptyRefs());
    for (const f of lose.flags) out.flags.add(f);
    for (const k of lose.counters) out.counters.add(k);
  }
  return out;
}

/**
 * Actor def ids whose defeat the run still needs (count not reached yet). An actor instance
 * matches by its current def id or any earlier form (formerDefIds).
 */
export function requiredDefeats(ctx: Ctx): Set<string> {
  const refs = emptyRefs();
  for (const c of progressConditions(ctx)) collectRefs(c, refs);
  const out = new Set<string>();
  for (const [id, n] of refs.defeats) if ((ctx.s.defeated[id] ?? 0) < n) out.add(id);
  return out;
}
