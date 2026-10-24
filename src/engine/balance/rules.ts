/**
 * Power impact of a rule variant, in "player hp per 100 turns" (positive = harms the player,
 * negative = helps). Used by the static balance check and by autoRebalance to soften rules.
 *
 * This is a local estimate; if the engine provides its own `estimateRuleImpact` (src/engine/rules.ts,
 * used for GM add_rule checks), the balance code should agree with it in sign and rough size.
 */
import type { Effect, ItemDef, RuleVariant, Trigger, WorldSpec } from '../../schema/world';
import { avgAmount, itemProfile } from '../sim/view';

export interface RuleImpact {
  id: string;
  /** hp-equivalent per 100 turns; positive = harmful */
  hpPer100: number;
  magnitude: 'none' | 'minor' | 'moderate' | 'major';
  harmful: boolean;
  notes: string[];
}

/** rough hp value of one effect landing on the player (positive = harm) */
export function effectHarm(world: WorldSpec, e: Effect): number {
  switch (e.type) {
    case 'damage':
      return avgAmount(e.amount);
    case 'heal':
      return -avgAmount(e.amount);
    case 'resource': {
      const v = avgAmount(e.amount);
      if (e.resource === 'hp') return -v;
      const res = (world.resources ?? []).find((r) => r.id === e.resource);
      // resources that kill or hurt when empty matter more
      const weight = res?.emptyIsDeath ? 0.5 : res && res.onEmpty.length ? 0.25 : e.resource === 'mp' ? 0.3 : 0.1;
      return -v * weight;
    }
    case 'modify_stat':
      return -(e.amount * (e.stat === 'hp' ? 1 : e.stat === 'ac' ? 3 : 2)) * (e.duration ? Math.min(1, e.duration / 20) : 1);
    case 'apply_status': {
      const st = (world.statuses ?? []).find((s) => s.id === e.status);
      if (!st) return 0;
      let per = 0;
      for (const pe of st.perTurn) per += effectHarm(world, pe);
      let mods = 0;
      for (const m of st.modifiers) mods -= m.amount * (m.stat === 'ac' ? 0.6 : 0.3);
      const flags = st.flags.reduce((n, f) => n + (['stunned', 'rooted', 'afraid', 'blinded', 'confused', 'silenced', 'slowed', 'charmed'].includes(f) ? 1.5 : ['hasted', 'regenerating', 'invisible'].includes(f) ? -1.5 : 0), 0);
      const sign = st.harmful ? 1 : -1;
      return per * e.duration + (Math.abs(mods) + Math.abs(flags)) * sign * Math.min(1, e.duration / 5);
    }
    case 'remove_status':
      return -0.5;
    case 'summon':
      return e.allied ? -3 * e.count : 6 * e.count;
    case 'spawn_item':
      return -1;
    case 'noise':
      return e.radius / 10;
    case 'teleport':
      return e.mode === 'random' ? 1 : 0;
    default:
      return 0;
  }
}

/** expected harm of one trigger per 100 turns */
function triggerHarm(world: WorldSpec, tr: Trigger): number {
  let per = 0;
  for (const e of tr.action.effects) per += effectHarm(world, e);
  const fires = (() => {
    switch (tr.on) {
      case 'on_turn':
        return 100 / (tr.every ?? 1);
      case 'on_hit':
      case 'on_hurt':
        return 25;
      case 'on_kill':
        return 4;
      case 'on_area_enter':
        return 0.4;
      case 'on_enter_tile':
        return 80;
      case 'on_low_hp':
        return 0.5;
      case 'on_resource_empty':
        return 1;
      default:
        return 1;
    }
  })();
  // a trigger whose action only works while a condition holds (e.g. "while Credentials are 0")
  // fires far less than its schedule says; chance conditions are already a rate
  const cond = tr.action.condition;
  const gated = cond && cond.type !== 'chance' ? CONDITIONAL_SHARE : cond?.type === 'chance' ? cond.p : 1;
  return per * fires * tr.chance * gated;
}

/** share of the time a condition-gated rule trigger is assumed to apply */
export const CONDITIONAL_SHARE = 0.3;

export function estimateRuleImpact(world: WorldSpec, rule: RuleVariant): RuleImpact {
  const notes: string[] = [];
  let hp = 0;
  for (const tr of rule.playerTriggers ?? []) {
    const h = triggerHarm(world, tr);
    if (Math.abs(h) >= 0.5) notes.push(`${tr.on}${tr.every ? ` every ${tr.every}` : ''}: ${h > 0 ? '+' : ''}${h.toFixed(1)} hp/100t`);
    hp += h;
  }
  const sw = rule.switches ?? {};
  const regenEvery = world.player.hpRegenEvery;
  if (sw.noNaturalHpRegen && regenEvery > 0) {
    const v = 100 / regenEvery;
    hp += v;
    notes.push(`no natural regeneration (−${v.toFixed(0)} hp/100t)`);
  }
  if (typeof sw.darkness === 'number' && sw.darkness < 1) {
    const v = (1 - sw.darkness) * 8;
    hp += v;
    notes.push(`darkness ×${sw.darkness}`);
  }
  if (sw.noLoot) {
    hp += 3;
    notes.push('no loot');
  }
  if (sw.durability) {
    hp += 2;
    notes.push('equipment wears out');
  }
  if (sw.allConsumablesUnknown) {
    hp += 2;
    notes.push('consumables unidentified');
  }
  if (sw.permadeathMercy) {
    hp -= world.player.stats.hp / 3;
    notes.push('one mercy from death');
  }
  const a = Math.abs(hp);
  const magnitude = a < 1 ? 'none' : a < 6 ? 'minor' : a < 15 ? 'moderate' : 'major';
  return { id: rule.id, hpPer100: Math.round(hp * 10) / 10, magnitude, harmful: hp > 0, notes };
}

/** expected player turns spent per area size (for per-turn rule and resource harm) */
export const AREA_TURNS: Record<string, number> = { small: 150, medium: 250, large: 350 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** engine RESOURCE_EMPTY_REPEAT: onEmpty effects fire again every this many turns while empty */
const EMPTY_REPEAT = 5;
/** share of an area's turns the player is assumed to spend on a refilling terrain (when present) */
const STAND_SHARE = 0.1;
/** harm of running dry on a resource whose empty state kills */
const EMPTY_DEATH_HARM = 60;

export interface ResourceDrain {
  id: string;
  /** mean harm per 100 turns over the run (hp-equivalent) */
  hpPer100: number;
  /** turns from `start` to empty with no refills (null = never drains) */
  turnsToEmpty: number | null;
  /** per area: expected hp-equivalent harm while the resource is empty there */
  perArea: number[];
  /** per area: expected turns spent empty */
  emptyTurns: number[];
  /** per area: expected refill amount (items, terrain, rules) */
  refills: number[];
}

/** resource change of one effect list (positive = refills `id`) */
function resourceFlow(effects: Effect[], id: string): number {
  let n = 0;
  for (const e of effects) if (e.type === 'resource' && e.resource === id) n += avgAmount(e.amount);
  return n;
}

/**
 * Harm of the custom resources themselves (drains whose empty state hurts), area by area.
 * The resource level is tracked across areas: it starts at `start`, drains by perTurn and by
 * draining rule triggers, and is refilled by what the area offers — spawn-table and placed items
 * that restore it (each counted at its spawn share), terrain that refills while standing on it,
 * and rule triggers (on_area_enter refills, on_turn / on_kill flows). Only the turns left over
 * after the level hits zero cost hp, at the onEmpty effects' rate (they repeat every 5 turns).
 */
export function resourceDrainHarm(world: WorldSpec): ResourceDrain[] {
  return (world.resources ?? []).map((r) => {
    const turnsToEmpty = r.perTurn < 0 ? Math.round(r.start / -r.perTurn) : null;
    let emptyHarm = 0;
    for (const e of r.onEmpty) emptyHarm += effectHarm(world, e);
    emptyHarm = Math.max(0, emptyHarm);
    const perArea: number[] = [];
    const emptyTurns: number[] = [];
    const refills: number[] = [];
    let level = r.start;
    let totalTurns = 0;
    for (const plan of world.areas) {
      const turns = AREA_TURNS[plan.size] ?? 250;
      totalTurns += turns;
      // continuous flow per turn (negative = drain)
      let flow = r.perTurn;
      // refills over the area: instant ones (area entry) are capped by `max`; items are carried
      // and used when needed, and refilling ground can be revisited, so those are not
      let instant = 0;
      let banked = 0;
      for (const rule of world.rules ?? []) {
        for (const tr of rule.playerTriggers) {
          const v = resourceFlow(tr.action.effects, r.id) * tr.chance;
          if (!v) continue;
          if (tr.on === 'on_area_enter') instant += v;
          else if (tr.on === 'on_turn') flow += v / Math.max(1, tr.every ?? 1);
          else if (tr.on === 'on_kill') banked += (v * 4 * turns) / 100;
        }
      }
      const table = plan.items.filter((e) => e.weight > 0 && world.items.some((x) => x.id === e.item));
      const wsum = table.reduce((n, e) => n + e.weight, 0);
      for (const e of table) {
        const def = world.items.find((x) => x.id === e.item)!;
        const v = Math.max(0, itemResourceGain(world, def, r.id));
        if (v > 0 && wsum > 0) banked += (plan.itemCount * e.weight * v) / wsum;
      }
      for (const pi of plan.placedItems) {
        const def = world.items.find((x) => x.id === pi.item);
        if (def) banked += Math.max(0, itemResourceGain(world, def, r.id));
      }
      for (const pt of plan.terrain) {
        const t = (world.terrains ?? []).find((x) => x.id === pt.terrain);
        if (!t) continue;
        const v = resourceFlow(t.onStand ?? [], r.id);
        if (v > 0) banked += v * turns * STAND_SHARE;
        else if (v < 0) flow += v * STAND_SHARE * 0.5; // the player mostly avoids draining ground
      }
      refills.push(Math.round(instant + banked));
      // supply over the area vs the drain; the turns it can't cover are spent empty
      const supply = Math.min(r.max, Math.max(0, level + instant)) + banked;
      let empty = 0;
      if (flow < 0) empty = Math.max(0, turns - supply / -flow);
      level = clamp(supply + flow * turns, 0, r.max);
      emptyTurns.push(Math.round(empty));
      let harm = (emptyHarm * empty) / EMPTY_REPEAT;
      if (r.emptyIsDeath && empty > 0) harm += EMPTY_DEATH_HARM;
      perArea.push(Math.round(harm * 10) / 10);
    }
    const total = perArea.reduce((a, b) => a + b, 0);
    const hpPer100 = totalTurns ? (total * 100) / totalTurns : 0;
    return { id: r.id, hpPer100: Math.round(hpPer100 * 10) / 10, turnsToEmpty, perArea, emptyTurns, refills };
  });
}

/** how much one use of an item restores resource `id` (consumed / charges / reusable uses count once) */
function itemResourceGain(world: WorldSpec, def: ItemDef, id: string): number {
  let n = itemProfile(world, def).resources[id] ?? 0;
  if (def.useMode === 'charges') n *= def.charges ?? 1;
  return n;
}
