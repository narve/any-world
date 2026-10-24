/** UI descriptions of items and actors that respect what the player knows. */
import type { Action, Amount, Effect, ItemDef, Targeting } from '../schema/world';
import type { ActorInstance, ActorView, ItemInstance, ItemView } from './types';
import { type Ctx, actorDef, damageTypeName, isPlayer, playerActor, statName, statusName } from './ctx';
import { knowledgeOf } from './knowledge';
import { displayItemName, equipSlotOf, equippedKindOf } from './inventory';
import { attackOf } from './combat';
import { maxHp } from './stats';

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export function formatAmount(ctx: Ctx, a: Amount): string {
  const parts: string[] = [];
  if (a.dice) parts.push(a.dice);
  if (a.base) parts.push(parts.length ? (a.base > 0 ? `+${a.base}` : `${a.base}`) : `${a.base}`);
  let s = parts.join('') || '0';
  if (a.scale && a.scale.factor) s += ` + ${Math.round(a.scale.factor * 100)}% ${statName(ctx, a.scale.stat)}`;
  return s;
}

export function avgAmount(a: Amount): number {
  let v = a.base ?? 0;
  if (a.dice) {
    const m = /^(\d+)d(\d+)$/.exec(a.dice);
    if (m) v += (Number(m[1]) * (Number(m[2]) + 1)) / 2;
  }
  return v;
}

export function effectLine(ctx: Ctx, e: Effect): string | null {
  switch (e.type) {
    case 'damage':
      return `Deals ${formatAmount(ctx, e.amount)} ${damageTypeName(ctx, e.damageType)} damage`;
    case 'heal':
      return `Restores ${formatAmount(ctx, e.amount)} ${statName(ctx, 'hp')}`;
    case 'resource': {
      const neg = (e.amount.base ?? 0) < 0 && !e.amount.dice;
      return `${neg ? '' : '+'}${formatAmount(ctx, e.amount)} ${statName(ctx, e.resource)}`;
    }
    case 'modify_stat':
      return `${signed(e.amount)} ${statName(ctx, e.stat)}${e.duration ? ` for ${e.duration} turns` : ' (permanent)'}`;
    case 'apply_status': {
      const harmful = ctx.ix.statuses.get(e.status)?.harmful;
      return `${harmful ? 'Inflicts' : 'Grants'} ${statusName(ctx, e.status)} (${e.duration} turns)`;
    }
    case 'remove_status':
      return e.status === 'all_harmful' ? 'Removes harmful conditions' : `Removes ${statusName(ctx, e.status)}`;
    case 'teleport':
      return {
        random: 'Teleports to a random spot',
        to_target: 'Teleports to the target',
        swap: 'Swaps places with the target',
        to_exit: 'Teleports near the way onward',
      }[e.mode];
    case 'push':
      return `Pushes back ${e.distance}`;
    case 'pull':
      return `Pulls in ${e.distance}`;
    case 'summon':
      return `Summons ${ctx.ix.actors.get(e.actor)?.name ?? e.actor}${e.count > 1 ? ` ×${e.count}` : ''}${e.allied ? ' (allied)' : ''}`;
    case 'spawn_terrain':
      return `Creates ${ctx.ix.terrains.get(e.terrain)?.name ?? e.terrain}${e.radius ? ` (radius ${e.radius})` : ''}${e.duration ? ` for ${e.duration} turns` : ''}`;
    case 'spawn_item':
      return `Produces ${ctx.ix.items.has(e.item) ? displayItemName(ctx, e.item) : e.item}${e.count > 1 ? ` ×${e.count}` : ''}`;
    case 'reveal_map':
      return e.radius >= 99 ? 'Reveals the map' : `Reveals the surroundings (radius ${e.radius})`;
    case 'identify':
      return e.scope === 'one' ? 'Identifies an item you carry' : 'Identifies everything you carry';
    case 'transform':
      return `Transforms into ${ctx.ix.actors.get(e.into)?.name ?? e.into}`;
    case 'light':
      return `Light (radius ${e.radius}, ${e.duration} turns)`;
    case 'noise':
      return `Makes noise (radius ${e.radius})`;
    case 'grant_xp':
      return `+${e.amount} ${ctx.world.vocabulary.xp}`;
    case 'change_faction':
      return `Makes the target ${e.faction}`;
    default:
      return null;
  }
}

export function targetingLine(t: Targeting): string | null {
  const who = t.affects === 'enemies' ? '' : t.affects === 'allies' ? ', allies' : t.affects === 'all' ? ', everyone' : '';
  switch (t.shape) {
    case 'self':
      return null;
    case 'single':
      return `Target: one, range ${Math.max(1, t.range)}${who}`;
    case 'adjacent':
      return `Target: all adjacent${who}`;
    case 'ray':
      return `Target: line, range ${Math.max(1, t.range)}${who}`;
    case 'cone':
      return `Target: cone, length ${Math.max(1, t.radius || t.range)}${who}`;
    case 'area':
      return `Target: area radius ${t.radius}, range ${t.range}${who}`;
    case 'all_visible':
      return `Target: everything in sight${who}`;
  }
  return null;
}

export function actionLines(ctx: Ctx, a: Action): string[] {
  const out: string[] = [];
  for (const e of a.effects) {
    const l = effectLine(ctx, e);
    if (l) out.push(l);
  }
  const t = targetingLine(a.targeting);
  if (t) out.push(t);
  if (a.condition?.type === 'chance') out.push(`${Math.round(a.condition.p * 100)}% chance`);
  return out;
}

export function itemEffectLines(ctx: Ctx, def: ItemDef, inst?: ItemInstance): string[] {
  const out: string[] = [];
  if (def.weapon) {
    const w = def.weapon;
    out.push(`${ctx.world.vocabulary.conflict}: ${formatAmount(ctx, w.damage)} ${damageTypeName(ctx, w.damageType)}${w.range > 1 ? `, range ${w.range}` : ''} (${statName(ctx, w.accuracyStat)})`);
  }
  if (typeof def.armour === 'number' && def.armour) out.push(`${signed(def.armour)} ${statName(ctx, 'ac')}`);
  for (const m of def.modifiers) out.push(`${signed(m.amount)} ${statName(ctx, m.stat)}${def.passiveWhenCarried ? ' while carried' : ''}`);
  if (def.onUse) out.push(...actionLines(ctx, def.onUse));
  for (const t of def.triggers) {
    const lines = t.action.effects.map((e) => effectLine(ctx, e)).filter((x): x is string => !!x);
    if (lines.length) out.push(`${t.on.replace(/^on_/, 'On ').replace(/_/g, ' ')}${t.every ? ` (every ${t.every})` : ''}: ${lines.join(', ')}`);
  }
  if (def.cost && def.cost.amount) out.push(`Costs ${def.cost.amount} ${statName(ctx, def.cost.resource)}`);
  if (def.cooldown) out.push(`Cooldown ${def.cooldown} turns`);
  if (def.useMode === 'charges') out.push(`Charges: ${inst?.charges ?? def.charges ?? 1}/${def.charges ?? 1}`);
  for (const r of def.requires) out.push(`Requires ${statName(ctx, r.stat)} ${r.min}`);
  if (inst && typeof inst.durability === 'number') out.push(`Durability ${inst.durability}`);
  return out;
}

function itemColor(ctx: Ctx, def: ItemDef): string {
  return def.model.colors?.primary ?? def.model.humanoid?.top ?? def.model.parts[0]?.color ?? ctx.world.palette.accent;
}

export function findItemInstance(ctx: Ctx, id: string): { item: ItemInstance; slot: number | null } | null {
  const slot = ctx.s.player.slots.findIndex((s) => s && s.id === id);
  if (slot >= 0) return { item: ctx.s.player.slots[slot]!, slot };
  const fi = ctx.s.area.items.find((f) => f.item.id === id);
  return fi ? { item: fi.item, slot: null } : null;
}

export function viewItem(ctx: Ctx, item: ItemInstance, slot: number | null): ItemView {
  const def = ctx.ix.items.get(item.defId);
  if (!def) {
    return { name: item.defId, kind: '', description: '', knowledge: 'clear', effectLines: [], notes: [], count: item.count, equipped: false, usable: false, color: '#888888' };
  }
  const k = knowledgeOf(ctx, def.id);
  const equipped = slot !== null && !!equippedKindOf(ctx, slot);
  const usable = !!def.onUse && def.useMode !== 'passive' ? !(def.useMode === 'charges' && (item.charges ?? 0) <= 0) : !!equipSlotOf(def) && !equipped;
  const view: ItemView = {
    name: k.level === 'unknown' && k.appearance ? cap(k.appearance.label) : def.name,
    kind: def.kind,
    description: k.level === 'unknown' ? "You don't know what this does." : def.description,
    knowledge: k.level,
    effectLines: k.level === 'clear' ? itemEffectLines(ctx, def, item) : [],
    notes: [...k.notes],
    count: item.count,
    equipped,
    usable,
    color: k.level === 'unknown' && k.appearance ? k.appearance.color : itemColor(ctx, def),
  };
  if (k.level === 'vague' && def.vagueText) view.vagueText = def.vagueText;
  if (item.charges !== undefined) view.charges = item.charges;
  return view;
}

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** rough expected damage per turn of an actor's attack */
function dpt(ctx: Ctx, a: ActorInstance): number {
  const info = attackOf(ctx, a);
  let best = info ? avgAmount(info.attack.damage) : 0;
  const def = actorDef(ctx, a);
  for (const ab of def?.abilities ?? []) {
    for (const e of ab.action.effects) if (e.type === 'damage') best = Math.max(best, avgAmount(e.amount) * 0.6);
  }
  return Math.max(0.5, best);
}

export function viewActor(ctx: Ctx, a: ActorInstance): ActorView {
  const def = actorDef(ctx, a);
  const player = playerActor(ctx);
  let threat: ActorView['threat'] = 'trivial';
  if (!isPlayer(ctx, a)) {
    const theirs = maxHp(ctx, a) * dpt(ctx, a);
    const ours = Math.max(1, maxHp(ctx, player) * dpt(ctx, player));
    const r = theirs / ours;
    threat = r < 0.15 ? 'trivial' : r < 0.5 ? 'even' : r < 1.2 ? 'dangerous' : 'deadly';
    if (a.faction !== 'hostile' && !def?.attack) threat = 'trivial';
  }
  return {
    name: isPlayer(ctx, a) ? ctx.world.player.name : (def?.name ?? a.defId),
    description: isPlayer(ctx, a) ? ctx.world.player.description : (def?.description ?? ''),
    hp: a.hp,
    maxHp: maxHp(ctx, a),
    faction: a.faction,
    statuses: a.statuses.map((s) => statusName(ctx, s.id)),
    threat,
    isNpc: !!def?.npc,
  };
}
