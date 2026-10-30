/**
 * Triggers. The player's live triggers come from the rules in force (rules.ts), chosen perks, equipped items and
 * passiveWhenCarried items; other actors use their ActorDef triggers. Item-specific events
 * (on_pickup / on_equip / on_unequip) fire only that item's triggers via `fireItemTriggers`.
 */
import type { ItemDef, Trigger, TriggerEvent } from '../schema/world';
import type { ActorInstance, Pos } from './types';
import { type Ctx, playerOf } from './ctx';
import { activeItems } from './stats';
import { runAction } from './effects';
import { activeRuleVariants } from './rules';
import { worldClockFactor } from './difficulty';

export interface TriggerCtx {
  other?: ActorInstance | null;
  pos?: Pos;
}

const ITEM_ONLY_EVENTS = new Set<TriggerEvent>(['on_pickup', 'on_equip', 'on_unequip']);
const MAX_DEPTH = 6;

/** triggers that come from world rules: their `every N turns` is a world clock (worldClockFactor) */
const RULE_TRIGGERS = new WeakSet<Trigger>();

export function triggersFor(ctx: Ctx, holder: ActorInstance): Trigger[] {
  const ps = playerOf(ctx, holder);
  if (ps) {
    const out: Trigger[] = [];
    for (const r of activeRuleVariants(ctx)) {
      for (const t of r.playerTriggers ?? []) {
        RULE_TRIGGERS.add(t);
        out.push(t);
      }
    }
    for (const id of ps.perks) {
      const p = ctx.ix.perks.get(id);
      if (p) out.push(...p.triggers);
    }
    for (const ai of activeItems(ctx, ps)) out.push(...ai.def.triggers);
    return out;
  }
  return ctx.ix.actors.get(holder.defId)?.triggers ?? [];
}

/** a trigger's `every`, stretched for a party when it is a world rule's clock */
function clockEvery(ctx: Ctx, t: Trigger): number {
  const every = t.every ?? 1;
  const f = RULE_TRIGGERS.has(t) ? worldClockFactor(ctx.s) : 1;
  return f === 1 ? every : Math.max(1, Math.round(every * f));
}

function run(ctx: Ctx, holder: ActorInstance, list: readonly Trigger[], event: TriggerEvent, tc: TriggerCtx): void {
  if (ctx.depth >= MAX_DEPTH) return;
  ctx.depth++;
  try {
    for (const t of list) {
      if (t.on !== event) continue;
      if (ctx.s.status !== 'playing') return;
      if (event === 'on_turn' && t.every && t.every > 1 && ctx.s.turn % clockEvery(ctx, t) !== 0) continue;
      if (!ctx.rng.chance(t.chance)) continue;
      const other = tc.other && tc.other.hp > 0 ? tc.other : null;
      runAction(ctx, t.action, holder, { targetPos: other?.pos ?? tc.pos, targetActor: other });
    }
  } finally {
    ctx.depth--;
  }
}

/** fire the holder's triggers for an event (item-only events are ignored here) */
export function fireTriggers(ctx: Ctx, holder: ActorInstance, event: TriggerEvent, tc: TriggerCtx = {}): void {
  if (ITEM_ONLY_EVENTS.has(event)) return;
  const list = triggersFor(ctx, holder);
  if (!list.length) return;
  run(ctx, holder, list, event, tc);
}

/** fire one item's triggers for on_pickup / on_equip / on_unequip */
export function fireItemTriggers(ctx: Ctx, holder: ActorInstance, def: ItemDef, event: TriggerEvent): void {
  if (!def.triggers.length) return;
  run(ctx, holder, def.triggers, event, { pos: holder.pos });
}

/** fire the triggers of a specific actor def (e.g. an earlier form of a transformed actor) */
export function fireDefTriggers(ctx: Ctx, holder: ActorInstance, defId: string, event: TriggerEvent, tc: TriggerCtx = {}): void {
  if (ITEM_ONLY_EVENTS.has(event)) return;
  const list = ctx.ix.actors.get(defId)?.triggers ?? [];
  if (!list.length) return;
  run(ctx, holder, list, event, tc);
}
