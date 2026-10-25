/** UI descriptions of items and actors that respect what the player knows. */
import type { Action, Amount, Effect, ItemDef, Targeting, TriggerEvent } from '../schema/world';
import type { ActorInstance, ActorView, ItemEffectLine, ItemInstance, ItemView } from './types';
import { ITEM_FX_KEYS, type ItemFxKey, type LogParams, renderTemplate } from './log-keys';
import { type Ctx, actorDef, damageTypeName, isPlayer, playerActor, statName, statusName } from './ctx';
import { knowledgeOf } from './knowledge';
import { displayItemName, equipSlotOf, equippedKindOf } from './inventory';
import { attackOf } from './combat';
import { maxHp } from './stats';

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** a catalog line: English text rendered from ITEM_FX_KEYS (sub-lines' English filled into params) */
function fx(key: ItemFxKey, params: LogParams = {}, sub?: Record<string, ItemEffectLine | ItemEffectLine[]>): ItemEffectLine {
  const all: LogParams = { ...params };
  if (sub) for (const [k, v] of Object.entries(sub)) all[k] = Array.isArray(v) ? v.map((l) => l.text).join(', ') : v.text;
  const line: ItemEffectLine = { key: key, params: all, text: renderTemplate(ITEM_FX_KEYS[key], all) };
  if (sub) line.sub = sub;
  return line;
}

/** dice and base of an amount: "2d4+1", "7", "0" */
function amountCore(a: Amount): string {
  const parts: string[] = [];
  if (a.dice) parts.push(a.dice);
  if (a.base) parts.push(parts.length ? (a.base > 0 ? `+${a.base}` : `${a.base}`) : `${a.base}`);
  return parts.join('') || '0';
}

/** an amount as a param: a string, or (scaled by a stat) a sub-line "2d4 + 50% Might" */
function amountParam(ctx: Ctx, a: Amount): { amount: string; sub?: ItemEffectLine } {
  const core = amountCore(a);
  if (!a.scale || !a.scale.factor) return { amount: core };
  const sub = fx('item.fx.amount_scaled', { amount: core, pct: Math.round(a.scale.factor * 100), stat: statName(ctx, a.scale.stat) });
  return { amount: sub.text, sub };
}

/** fx() with an Amount in `{amount}` */
function fxAmount(ctx: Ctx, key: ItemFxKey, a: Amount, params: LogParams): ItemEffectLine {
  const am = amountParam(ctx, a);
  return fx(key, { ...params, amount: am.amount }, am.sub ? { amount: am.sub } : undefined);
}

export function formatAmount(ctx: Ctx, a: Amount): string {
  return amountParam(ctx, a).amount;
}

export function avgAmount(a: Amount): number {
  let v = a.base ?? 0;
  if (a.dice) {
    const m = /^(\d+)d(\d+)$/.exec(a.dice);
    if (m) v += (Number(m[1]) * (Number(m[2]) + 1)) / 2;
  }
  return v;
}

/** one effect as a catalog line, or null for effects that are not shown */
export function effectFx(ctx: Ctx, e: Effect): ItemEffectLine | null {
  switch (e.type) {
    case 'damage':
      return fxAmount(ctx, 'item.fx.damage', e.amount, { damageType: damageTypeName(ctx, e.damageType) });
    case 'heal':
      return fxAmount(ctx, 'item.fx.heal', e.amount, { stat: statName(ctx, 'hp') });
    case 'resource': {
      const neg = (e.amount.base ?? 0) < 0 && !e.amount.dice;
      return fxAmount(ctx, neg ? 'item.fx.resource_loss' : 'item.fx.resource_gain', e.amount, { stat: statName(ctx, e.resource) });
    }
    case 'modify_stat':
      return e.duration
        ? fx('item.fx.stat_temp', { amount: signed(e.amount), stat: statName(ctx, e.stat), n: e.duration })
        : fx('item.fx.stat_perm', { amount: signed(e.amount), stat: statName(ctx, e.stat) });
    case 'apply_status': {
      const harmful = ctx.ix.statuses.get(e.status)?.harmful;
      return fx(harmful ? 'item.fx.status_inflict' : 'item.fx.status_grant', { status: statusName(ctx, e.status), n: e.duration });
    }
    case 'remove_status':
      return e.status === 'all_harmful' ? fx('item.fx.cleanse') : fx('item.fx.remove_status', { status: statusName(ctx, e.status) });
    case 'teleport':
      return fx(`item.fx.teleport_${e.mode}`);
    case 'push':
      return fx('item.fx.push', { n: e.distance });
    case 'pull':
      return fx('item.fx.pull', { n: e.distance });
    case 'summon': {
      const actor = ctx.ix.actors.get(e.actor)?.name ?? e.actor;
      const many = e.count > 1;
      const key = e.allied ? (many ? 'item.fx.summon_allied_many' : 'item.fx.summon_allied') : many ? 'item.fx.summon_many' : 'item.fx.summon';
      return fx(key, many ? { actor, count: e.count } : { actor });
    }
    case 'spawn_terrain': {
      const terrain = ctx.ix.terrains.get(e.terrain)?.name ?? e.terrain;
      if (e.radius && e.duration) return fx('item.fx.terrain_radius_turns', { terrain, radius: e.radius, n: e.duration });
      if (e.radius) return fx('item.fx.terrain_radius', { terrain, radius: e.radius });
      if (e.duration) return fx('item.fx.terrain_turns', { terrain, n: e.duration });
      return fx('item.fx.terrain', { terrain });
    }
    case 'spawn_item': {
      const item = ctx.ix.items.has(e.item) ? displayItemName(ctx, e.item) : e.item;
      return e.count > 1 ? fx('item.fx.spawn_item_many', { item, count: e.count }) : fx('item.fx.spawn_item', { item });
    }
    case 'reveal_map':
      return e.radius >= 99 ? fx('item.fx.reveal_map') : fx('item.fx.reveal_near', { radius: e.radius });
    case 'identify':
      return fx(e.scope === 'one' ? 'item.fx.identify_one' : 'item.fx.identify_all');
    case 'transform':
      return fx('item.fx.transform', { actor: ctx.ix.actors.get(e.into)?.name ?? e.into });
    case 'light':
      return fx('item.fx.light', { radius: e.radius, n: e.duration });
    case 'noise':
      return fx('item.fx.noise', { radius: e.radius });
    case 'grant_xp':
      return fx('item.fx.xp', { amount: e.amount, xp: ctx.world.vocabulary.xp });
    case 'currency':
      return fx('item.fx.currency', { amount: e.amount, currency: ctx.world.vocabulary.currency });
    case 'change_faction':
      return fx(`item.fx.faction_${e.faction}`);
    default:
      return null;
  }
}

/** one effect as English text (the fallback of effectFx) */
export function effectLine(ctx: Ctx, e: Effect): string | null {
  return effectFx(ctx, e)?.text ?? null;
}

/** where an action lands, as a catalog line; null for self-targeted actions */
export function targetingFx(t: Targeting): ItemEffectLine | null {
  const who = t.affects === 'allies' ? fx('item.fx.who_allies') : t.affects === 'all' ? fx('item.fx.who_all') : null;
  const line = (key: ItemFxKey, params: LogParams) => (who ? fx(key, params, { who }) : fx(key, { ...params, who: '' }));
  switch (t.shape) {
    case 'self':
      return null;
    case 'single':
      return line('item.fx.target_single', { range: Math.max(1, t.range) });
    case 'adjacent':
      return line('item.fx.target_adjacent', {});
    case 'ray':
      return line('item.fx.target_ray', { range: Math.max(1, t.range) });
    case 'cone':
      return line('item.fx.target_cone', { range: Math.max(1, t.radius || t.range) });
    case 'area':
      return line('item.fx.target_area', { radius: t.radius, range: t.range });
    case 'all_visible':
      return line('item.fx.target_all_visible', {});
  }
  return null;
}

export function targetingLine(t: Targeting): string | null {
  return targetingFx(t)?.text ?? null;
}

export function actionFx(ctx: Ctx, a: Action): ItemEffectLine[] {
  const out: ItemEffectLine[] = [];
  for (const e of a.effects) {
    const l = effectFx(ctx, e);
    if (l) out.push(l);
  }
  const t = targetingFx(a.targeting);
  if (t) out.push(t);
  if (a.condition?.type === 'chance') out.push(fx('item.fx.chance', { pct: Math.round(a.condition.p * 100) }));
  return out;
}

export function actionLines(ctx: Ctx, a: Action): string[] {
  return actionFx(ctx, a).map((l) => l.text);
}

const TRIGGER_KEYS: Record<TriggerEvent, ItemFxKey> = {
  on_hit: 'item.fx.on.on_hit',
  on_hurt: 'item.fx.on.on_hurt',
  on_kill: 'item.fx.on.on_kill',
  on_death: 'item.fx.on.on_death',
  on_turn: 'item.fx.on.on_turn',
  on_enter_tile: 'item.fx.on.on_enter_tile',
  on_pickup: 'item.fx.on.on_pickup',
  on_equip: 'item.fx.on.on_equip',
  on_unequip: 'item.fx.on.on_unequip',
  on_area_enter: 'item.fx.on.on_area_enter',
  on_resource_empty: 'item.fx.on.on_resource_empty',
  on_low_hp: 'item.fx.on.on_low_hp',
};

/** what an item does, as catalog lines (only shown when the item is fully known) */
export function itemEffectFx(ctx: Ctx, def: ItemDef, inst?: ItemInstance): ItemEffectLine[] {
  const out: ItemEffectLine[] = [];
  if (def.weapon) {
    const w = def.weapon;
    const params = { conflict: ctx.world.vocabulary.conflict, damageType: damageTypeName(ctx, w.damageType), stat: statName(ctx, w.accuracyStat) };
    out.push(w.range > 1 ? fxAmount(ctx, 'item.fx.weapon_ranged', w.damage, { ...params, range: w.range }) : fxAmount(ctx, 'item.fx.weapon', w.damage, params));
  }
  if (typeof def.armour === 'number' && def.armour) out.push(fx('item.fx.modifier', { amount: signed(def.armour), stat: statName(ctx, 'ac') }));
  for (const m of def.modifiers) out.push(fx(def.passiveWhenCarried ? 'item.fx.modifier_carried' : 'item.fx.modifier', { amount: signed(m.amount), stat: statName(ctx, m.stat) }));
  if (def.onUse) out.push(...actionFx(ctx, def.onUse));
  for (const t of def.triggers) {
    const effects = t.action.effects.map((e) => effectFx(ctx, e)).filter((x): x is ItemEffectLine => !!x);
    if (!effects.length) continue;
    const event = fx(TRIGGER_KEYS[t.on]);
    out.push(t.every ? fx('item.fx.trigger_every', { n: t.every }, { event, effects }) : fx('item.fx.trigger', {}, { event, effects }));
  }
  if (def.cost && def.cost.amount) out.push(fx('item.fx.cost', { amount: def.cost.amount, stat: statName(ctx, def.cost.resource) }));
  if (def.cooldown) out.push(fx('item.fx.cooldown', { n: def.cooldown }));
  if (def.useMode === 'charges') out.push(fx('item.fx.charges', { charges: inst?.charges ?? def.charges ?? 1, max: def.charges ?? 1 }));
  for (const r of def.requires) out.push(fx('item.fx.requires', { stat: statName(ctx, r.stat), min: r.min }));
  if (inst && typeof inst.durability === 'number') out.push(fx('item.fx.durability', { n: inst.durability }));
  return out;
}

/** what an item does, as English text (the fallback of itemEffectFx) */
export function itemEffectLines(ctx: Ctx, def: ItemDef, inst?: ItemInstance): string[] {
  return itemEffectFx(ctx, def, inst).map((l) => l.text);
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
    return { name: item.defId, kind: '', description: '', knowledge: 'clear', effectLines: [], effects: [], notes: [], count: item.count, equipped: false, usable: false, color: '#888888' };
  }
  const k = knowledgeOf(ctx, def.id);
  const equipped = slot !== null && !!equippedKindOf(ctx, slot);
  const effects = k.level === 'clear' ? itemEffectFx(ctx, def, item) : [];
  const usable = !!def.onUse && def.useMode !== 'passive' ? !(def.useMode === 'charges' && (item.charges ?? 0) <= 0) : !!equipSlotOf(def) && !equipped;
  const view: ItemView = {
    name: k.level === 'unknown' && k.appearance ? cap(k.appearance.label) : def.name,
    kind: def.kind,
    description: k.level === 'unknown' ? "You don't know what this does." : def.description,
    knowledge: k.level,
    effectLines: effects.map((l) => l.text),
    effects,
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
