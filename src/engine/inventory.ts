/**
 * Inventory: 28 generic slots (0–7 quick, 8–27 backpack), stacking, pickup/drop/move,
 * equipment (weapon/armour/trinket; equipped items stay in their slot), use modes
 * (consumed / charges / reusable with cost+cooldown / passive), requirements and durability.
 */
import type { ItemDef } from '../schema/world';
import type { ItemInstance, Pos } from './types';
import { QUICK_SLOTS, TOTAL_SLOTS } from './types';
import { type Ctx, emit, findFreeNear, itemName, logKey, nextId, playerActor, statName, tileWalkable } from './ctx';
import { getStat, hasFlag, maxHp, maxMp } from './stats';
import { fireItemTriggers } from './triggers';
import { type Obs, POSITIONAL_SHAPES, changeResource, isActorEffect, resolveTargets, runAction } from './effects';
import { knowledgeOf, learnFromUse } from './knowledge';
import { samePos, tileAt } from './util';
import { switchesOf } from './rules';

export const DEFAULT_DURABILITY = 40;

export interface ActionOutcome {
  ok: boolean;
  reason?: string;
  tookTurn: boolean;
  /** energy cost when the action took a turn (default 100) */
  cost?: number;
}

export const invalid = (reason: string): ActionOutcome => ({ ok: false, reason, tookTurn: false });
export const done = (cost = 100): ActionOutcome => ({ ok: true, tookTurn: true, cost });
export const free = (): ActionOutcome => ({ ok: true, tookTurn: false });

export type EquipKind = 'weapon' | 'armour' | 'trinket';

export function equipSlotOf(def: ItemDef): EquipKind | null {
  if (def.equipSlot) return def.equipSlot;
  if (def.category === 'weapon' && def.weapon) return 'weapon';
  if (def.category === 'armour') return 'armour';
  return null;
}

export function displayItemName(ctx: Ctx, defId: string): string {
  const k = knowledgeOf(ctx, defId);
  if (k.level === 'unknown' && k.appearance) return k.appearance.label;
  return itemName(ctx, defId);
}

export function makeItem(ctx: Ctx, defId: string, count = 1): ItemInstance | null {
  const def = ctx.ix.items.get(defId);
  if (!def) return null;
  const it: ItemInstance = { id: nextId(ctx, 'i'), defId, count: Math.max(1, Math.floor(count)) };
  if (def.useMode === 'charges') it.charges = def.charges ?? 1;
  if (switchesOf(ctx).durability && (def.weapon || typeof def.armour === 'number')) it.durability = DEFAULT_DURABILITY;
  return it;
}

export function countItem(ctx: Ctx, defId: string): number {
  let n = 0;
  for (const it of ctx.s.player.slots) if (it && it.defId === defId) n += it.count;
  return n;
}

export function equippedKindOf(ctx: Ctx, slot: number): EquipKind | null {
  const e = ctx.s.player.equipped;
  if (e.weapon === slot) return 'weapon';
  if (e.armour === slot) return 'armour';
  if (e.trinket === slot) return 'trinket';
  return null;
}

export function firstFreeSlot(ctx: Ctx, preferQuick = true): number {
  const slots = ctx.s.player.slots;
  const order: number[] = [];
  if (preferQuick) for (let i = 0; i < TOTAL_SLOTS; i++) order.push(i);
  else {
    for (let i = QUICK_SLOTS; i < TOTAL_SLOTS; i++) order.push(i);
    for (let i = 0; i < QUICK_SLOTS; i++) order.push(i);
  }
  for (const i of order) if (!slots[i]) return i;
  return -1;
}

/** puts an instance into the inventory (stacking first); returns slot or -1 when full */
export function addInstance(ctx: Ctx, it: ItemInstance, preferQuick = true): number {
  const def = ctx.ix.items.get(it.defId);
  if (!def) return -1;
  const slots = ctx.s.player.slots;
  if (def.stackable) {
    const i = slots.findIndex((s) => s && s.defId === it.defId);
    if (i >= 0) {
      slots[i]!.count += it.count;
      return i;
    }
  }
  const i = firstFreeSlot(ctx, preferQuick);
  if (i < 0) return -1;
  slots[i] = it;
  return i;
}

/** gives items to the player (on_pickup fires); what doesn't fit is dropped at their feet */
export function giveItem(ctx: Ctx, defId: string, count = 1): number {
  const def = ctx.ix.items.get(defId);
  if (!def) return 0;
  const p = playerActor(ctx);
  let given = 0;
  const units = def.stackable ? [count] : Array.from({ length: count }, () => 1);
  for (const n of units) {
    const it = makeItem(ctx, defId, n);
    if (!it) break;
    if (addInstance(ctx, it) >= 0) {
      given += n;
      emit(ctx, { type: 'item_picked', itemId: it.id, defId });
      fireItemTriggers(ctx, p, def, 'on_pickup');
    } else {
      placeFloorItem(ctx, it, p.pos);
    }
  }
  if (given > 1) logKey(ctx, 'log.item.receive_many', { player: ctx.world.player.name, item: displayItemName(ctx, defId), count: given }, 'loot');
  else if (given) logKey(ctx, 'log.item.receive', { player: ctx.world.player.name, item: displayItemName(ctx, defId) }, 'loot');
  return given;
}

function placeFloorItem(ctx: Ctx, it: ItemInstance, pos: Pos): void {
  let p = pos;
  const t = tileAt(ctx.s.area.map, p.x, p.y);
  if (!t || !tileWalkable(ctx, t)) p = findFreeNear(ctx, pos, 6) ?? pos;
  ctx.s.area.items.push({ item: it, pos: { x: p.x, y: p.y } });
}

/** creates items on the floor at (or next to) pos */
export function dropItemAt(ctx: Ctx, defId: string, count: number, pos: Pos): void {
  const def = ctx.ix.items.get(defId);
  if (!def) return;
  const units = def.stackable ? [count] : Array.from({ length: Math.min(count, 10) }, () => 1);
  for (const n of units) {
    const it = makeItem(ctx, defId, n);
    if (it) placeFloorItem(ctx, it, pos);
  }
}

export function requiresFailure(ctx: Ctx, def: ItemDef): string | null {
  const p = playerActor(ctx);
  for (const r of def.requires) {
    if (getStat(ctx, p, r.stat) < r.min) return `requires ${statName(ctx, r.stat)} ${r.min}`;
  }
  return null;
}

function clampVitals(ctx: Ctx): void {
  const p = playerActor(ctx);
  p.hp = Math.min(p.hp, maxHp(ctx, p));
  p.mp = Math.min(p.mp, maxMp(ctx, p));
}

function unequipSlot(ctx: Ctx, slot: number, announce = true): void {
  const kind = equippedKindOf(ctx, slot);
  if (!kind) return;
  ctx.s.player.equipped[kind] = null;
  const it = ctx.s.player.slots[slot];
  const def = it ? ctx.ix.items.get(it.defId) : undefined;
  if (def) {
    fireItemTriggers(ctx, playerActor(ctx), def, 'on_unequip');
    if (announce) logKey(ctx, 'log.item.unequip', { player: ctx.world.player.name, item: displayItemName(ctx, def.id) }, 'info');
  }
  clampVitals(ctx);
}

/** removes `count` from a slot (unequipping if it empties) */
export function removeFromSlot(ctx: Ctx, slot: number, count = 1): void {
  const it = ctx.s.player.slots[slot];
  if (!it) return;
  it.count -= count;
  if (it.count <= 0) {
    if (equippedKindOf(ctx, slot)) unequipSlot(ctx, slot, false);
    ctx.s.player.slots[slot] = null;
  }
}

/** durability loss for an equipped item (no-op unless the durability rule is on) */
export function damageEquipped(ctx: Ctx, slot: number | null): void {
  if (!switchesOf(ctx).durability || slot === null) return;
  const it = ctx.s.player.slots[slot];
  if (!it || typeof it.durability !== 'number') return;
  it.durability -= 1;
  if (it.durability <= 0) {
    const name = displayItemName(ctx, it.defId);
    unequipSlot(ctx, slot, false);
    ctx.s.player.slots[slot] = null;
    logKey(ctx, 'log.item.breaks', { item: name }, 'warning');
  }
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

export function validSlot(slot: unknown): slot is number {
  return Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < TOTAL_SLOTS;
}

export function doEquip(ctx: Ctx, slot: number): ActionOutcome {
  if (!validSlot(slot)) return invalid('no such slot');
  const it = ctx.s.player.slots[slot];
  if (!it) return invalid('that slot is empty');
  const def = ctx.ix.items.get(it.defId);
  if (!def) return invalid('unknown item');
  const kind = equipSlotOf(def);
  if (!kind) return invalid(`${displayItemName(ctx, def.id)} cannot be equipped`);
  if (ctx.s.player.equipped[kind] === slot) return invalid('already equipped');
  const req = requiresFailure(ctx, def);
  if (req) return invalid(req);
  const prev = ctx.s.player.equipped[kind];
  if (prev !== null) unequipSlot(ctx, prev, false);
  ctx.s.player.equipped[kind] = slot;
  emit(ctx, { type: 'equipped', slot });
  logKey(ctx, 'log.item.equip', { player: ctx.world.player.name, item: displayItemName(ctx, def.id) }, 'info');
  fireItemTriggers(ctx, playerActor(ctx), def, 'on_equip');
  clampVitals(ctx);
  return done();
}

export function doUnequip(ctx: Ctx, slot: number): ActionOutcome {
  if (!validSlot(slot)) return invalid('no such slot');
  if (!ctx.s.player.slots[slot]) return invalid('that slot is empty');
  if (!equippedKindOf(ctx, slot)) return invalid('not equipped');
  unequipSlot(ctx, slot);
  return done();
}

export function doMoveItem(ctx: Ctx, from: number, to: number): ActionOutcome {
  if (!validSlot(from) || !validSlot(to)) return invalid('no such slot');
  if (from === to) return invalid('same slot');
  const slots = ctx.s.player.slots;
  const a = slots[from];
  if (!a) return invalid('that slot is empty');
  const b = slots[to];
  const eq = ctx.s.player.equipped;
  const def = ctx.ix.items.get(a.defId);
  if (b && def?.stackable && b.defId === a.defId && !equippedKindOf(ctx, from) && !equippedKindOf(ctx, to)) {
    b.count += a.count;
    slots[from] = null;
    return done();
  }
  slots[to] = a;
  slots[from] = b;
  for (const k of ['weapon', 'armour', 'trinket'] as const) {
    if (eq[k] === from) eq[k] = to;
    else if (eq[k] === to) eq[k] = from;
  }
  return done();
}

export function doDrop(ctx: Ctx, slot: number): ActionOutcome {
  if (!validSlot(slot)) return invalid('no such slot');
  const it = ctx.s.player.slots[slot];
  if (!it) return invalid('that slot is empty');
  if (equippedKindOf(ctx, slot)) unequipSlot(ctx, slot, false);
  ctx.s.player.slots[slot] = null;
  const p = playerActor(ctx);
  ctx.s.area.items.push({ item: it, pos: { ...p.pos } });
  logKey(ctx, 'log.item.drop', { player: ctx.world.player.name, item: displayItemName(ctx, it.defId) }, 'info');
  return done();
}

export function doPickup(ctx: Ctx): ActionOutcome {
  const p = playerActor(ctx);
  const here = ctx.s.area.items.filter((fi) => samePos(fi.pos, p.pos));
  if (!here.length) return invalid('nothing here to pick up');
  let picked = 0;
  let full = false;
  for (const fi of here) {
    const def = ctx.ix.items.get(fi.item.defId);
    if (!def) continue;
    if (addInstance(ctx, fi.item) < 0) {
      full = true;
      continue;
    }
    ctx.s.area.items = ctx.s.area.items.filter((x) => x !== fi);
    picked++;
    emit(ctx, { type: 'item_picked', itemId: fi.item.id, defId: def.id });
    if (fi.item.count > 1) logKey(ctx, 'log.item.pickup_many', { player: ctx.world.player.name, item: displayItemName(ctx, def.id), count: fi.item.count }, 'loot');
    else logKey(ctx, 'log.item.pickup', { player: ctx.world.player.name, item: displayItemName(ctx, def.id) }, 'loot');
    fireItemTriggers(ctx, p, def, 'on_pickup');
  }
  if (!picked) return invalid('no room to carry that');
  if (full) logKey(ctx, 'log.item.no_room', {}, 'warning');
  return done();
}

/** why using this slot would fail (null = usable); `target` validated for positional items */
export function useFailure(ctx: Ctx, slot: number, target?: Pos): string | null {
  if (!validSlot(slot)) return 'no such slot';
  const it = ctx.s.player.slots[slot];
  if (!it) return 'that slot is empty';
  const def = ctx.ix.items.get(it.defId);
  if (!def) return 'unknown item';
  const kind = equipSlotOf(def);
  if (def.useMode === 'passive' || !def.onUse) {
    if (kind) {
      if (ctx.s.player.equipped[kind] === slot) return 'already equipped';
      return requiresFailure(ctx, def);
    }
    return 'nothing happens when you use that';
  }
  if (def.useMode === 'charges' && (it.charges ?? 0) <= 0) return 'no charges left';
  if ((it.cooldown ?? 0) > 0) return `not ready (${it.cooldown} turns)`;
  const req = requiresFailure(ctx, def);
  if (req) return req;
  const p = playerActor(ctx);
  if (def.category === 'spell' && hasFlag(ctx, p, 'silenced')) return 'silenced';
  if (def.cost && def.cost.amount > 0 && getStat(ctx, p, def.cost.resource) < def.cost.amount) return `not enough ${statName(ctx, def.cost.resource)}`;
  const t = def.onUse.targeting;
  if (POSITIONAL_SHAPES.has(t.shape)) {
    // range, line of sight and bounds apply to "only me" positional items too (a blink can't
    // reach through a wall)
    const tr = resolveTargets(ctx, p, t, target, def.onUse.effects);
    if (!tr.ok) return tr.reason;
    if (t.shape === 'single' && !tr.actors.length && def.onUse.effects.every(isActorEffect)) return 'no valid target there';
  }
  return null;
}

export function doUse(ctx: Ctx, slot: number, target?: Pos): ActionOutcome {
  const fail = useFailure(ctx, slot, target);
  if (fail) return invalid(fail);
  const it = ctx.s.player.slots[slot]!;
  const def = ctx.ix.items.get(it.defId)!;
  if (def.useMode === 'passive' || !def.onUse) return doEquip(ctx, slot);
  const p = playerActor(ctx);
  const shownName = displayItemName(ctx, def.id);
  logKey(ctx, 'log.item.use', { player: ctx.world.player.name, item: shownName }, 'info');
  if (def.cost && def.cost.amount > 0) changeResource(ctx, p, def.cost.resource, -def.cost.amount);
  // consume before effects so the item can't be duplicated by its own effects
  let consumed = false;
  if (def.useMode === 'consumed') {
    removeFromSlot(ctx, slot, 1);
    consumed = true;
  } else if (def.useMode === 'charges') {
    it.charges = Math.max(0, (it.charges ?? 1) - 1);
    if (it.charges === 0) logKey(ctx, 'log.item.spent', { item: shownName }, 'info');
  }
  // the round tick right after this action takes one off, so +1 makes "cooldown N" block the next N turns;
  // for a consumed stack the cooldown sits on what is left of the stack
  const holder = consumed ? ctx.s.player.slots[slot] : it;
  if (def.cooldown > 0 && holder && holder.defId === def.id) holder.cooldown = def.cooldown + 1;
  const obs: Obs[] = [];
  const res = runAction(ctx, def.onUse, p, { targetPos: target, obs });
  ctx.s.stats.itemsUsed += 1;
  emit(ctx, { type: 'item_used', defId: def.id, consumed });
  learnFromUse(ctx, def, obs, !!res.conditionFailed || !res.ok);
  return done();
}

/** convenience for describe/legal: is there a floor item under the player */
export function itemsUnderPlayer(ctx: Ctx): number {
  const p = playerActor(ctx);
  return ctx.s.area.items.filter((fi) => samePos(fi.pos, p.pos)).length;
}

