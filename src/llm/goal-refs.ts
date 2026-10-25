/**
 * What a world's goal (goal.win / goal.lose) and area locks (transitionRequires) depend on: the
 * flags, counters and items the GM and NPC dialogue must never write or hand out, the actors
 * (actor_defeated) they must never defeat, transform or turn, and the stats they must never push,
 * by fiat
 * (gm-checks.goalWriteProblem), also listed in the GM / dialogue prompts. Browser-safe, pure.
 */
import type { Condition, WorldSpec } from '../schema/world';

/** longest a GM effect may put a harmful status on anyone (world sources use about 5 turns; gm-checks.boundProblem) */
export const GM_HARMFUL_STATUS_TURNS = 10;

/** what the world's goal (win / lose) and area locks (transitionRequires) depend on */
export interface GoalRefs {
  flags: ReadonlySet<string>;
  counters: ReadonlySet<string>;
  items: ReadonlySet<string>;
  /** actor defs named by actor_defeated: only the player's own play may defeat them */
  actors: ReadonlySet<string>;
  /** stats / resources read by stat conditions: no GM resource / modify_stat effect on them */
  stats: ReadonlySet<string>;
}

type MutableRefs = { [K in keyof GoalRefs]: Set<string> };

function collectRefs(c: Condition, out: MutableRefs): void {
  switch (c.type) {
    case 'all':
    case 'any':
      c.of.forEach((x) => collectRefs(x, out));
      break;
    case 'not':
      collectRefs(c.cond, out);
      break;
    case 'flag':
      out.flags.add(c.flag);
      break;
    case 'counter':
      out.counters.add(c.counter);
      break;
    case 'has_item':
      out.items.add(c.item);
      break;
    case 'actor_defeated':
      out.actors.add(c.actor);
      break;
    case 'stat':
      out.stats.add(c.stat);
      break;
    default:
      break;
  }
}

const goalRefsCache = new WeakMap<WorldSpec, GoalRefs>();
/** flags, counters, items, actors and stats the goal and the area locks reference (cached per world object) */
export function goalRefs(world: WorldSpec): GoalRefs {
  let r = goalRefsCache.get(world);
  if (!r) {
    const out: MutableRefs = { flags: new Set(), counters: new Set(), items: new Set(), actors: new Set(), stats: new Set() };
    collectRefs(world.goal.win, out);
    if (world.goal.lose) collectRefs(world.goal.lose, out);
    for (const area of world.areas) if (area.transitionRequires) collectRefs(area.transitionRequires, out);
    r = out;
    goalRefsCache.set(world, r);
  }
  return r;
}

/** one prompt line naming what the GM must never set, change or hand out ('' when nothing) */
export function protectedGoalLine(world: WorldSpec, opts: { npcStockAllowed?: boolean } = {}): string {
  const r = goalRefs(world);
  const parts: string[] = [];
  const q = (xs: ReadonlySet<string>) => [...xs].map((x) => `"${x}"`).join(', ');
  if (r.flags.size) parts.push(`flags ${q(r.flags)} (never set_flag them)`);
  if (r.counters.size) parts.push(`counters ${q(r.counters)} (no counter effects on them)`);
  if (r.items.size) parts.push(`items ${q(r.items)} (never give_item / place_item / spawn_item / reward them${opts.npcStockAllowed ? ", unless they are in the speaking NPC's own stock" : ''})`);
  if (r.actors.size) parts.push(`actors ${q(r.actors)} (never damage, transform, harm, change_faction, spawn or summon them; the player defeats them)`);
  if (r.stats.size) parts.push(`stats ${q(r.stats)} (no resource / modify_stat effects on them)`);
  return parts.length
    ? `- The goal and the area locks are the player's to earn; any action that touches them is refused, and so is any action that would win or lose the run outright (also: no lethal damage to the player). Protected: ${parts.join('; ')}.`
    : '- No action may win or lose the run outright (no lethal damage to the player).';
}
