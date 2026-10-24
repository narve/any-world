/** Effective stats: base + temporary mods + status modifiers + equipment/carried items. */
import type { ItemDef, StatusDef } from '../schema/world';
import type { ActorInstance, ItemInstance } from './types';
import { type Ctx, isPlayer } from './ctx';
import { switchesOf } from './rules';

export type Side = 'P' | 'H' | 'N' | 'F';

export const LOW_HP_FRACTION = 0.3;

export function statMod(v: number): number {
  return Math.floor((v - 10) / 2);
}

export interface ActiveItem {
  def: ItemDef;
  item: ItemInstance;
  slot: number;
  equipped: boolean;
}

/** player items whose modifiers/triggers are live: equipped ones, and passiveWhenCarried ones */
export function activeItems(ctx: Ctx): ActiveItem[] {
  const p = ctx.s.player;
  const eq = new Set<number>();
  for (const v of [p.equipped.weapon, p.equipped.armour, p.equipped.trinket]) if (v !== null && v !== undefined) eq.add(v);
  const out: ActiveItem[] = [];
  p.slots.forEach((it, i) => {
    if (!it) return;
    const def = ctx.ix.items.get(it.defId);
    if (!def) return;
    const equipped = eq.has(i);
    if (equipped || def.passiveWhenCarried) out.push({ def, item: it, slot: i, equipped });
  });
  return out;
}

export function statusDefs(ctx: Ctx, a: ActorInstance): StatusDef[] {
  const out: StatusDef[] = [];
  for (const s of a.statuses) {
    const d = ctx.ix.statuses.get(s.id);
    if (d) out.push(d);
  }
  return out;
}

export function hasFlag(ctx: Ctx, a: ActorInstance, flag: StatusDef['flags'][number]): boolean {
  for (const s of a.statuses) {
    const d = ctx.ix.statuses.get(s.id);
    if (d && d.flags.includes(flag)) return true;
  }
  return false;
}

/** sum of all live modifiers for a stat */
export function modSum(ctx: Ctx, a: ActorInstance, stat: string): number {
  let sum = 0;
  for (const m of a.tempMods) if (m.stat === stat) sum += m.amount;
  for (const d of statusDefs(ctx, a)) for (const m of d.modifiers) if (m.stat === stat) sum += m.amount;
  if (isPlayer(ctx, a)) {
    for (const ai of activeItems(ctx)) {
      for (const m of ai.def.modifiers) if (m.stat === stat) sum += m.amount;
      if (stat === 'ac' && ai.equipped && typeof ai.def.armour === 'number') sum += ai.def.armour;
    }
  }
  return sum;
}

export function maxHp(ctx: Ctx, a: ActorInstance): number {
  return Math.max(1, a.maxHp + modSum(ctx, a, 'hp'));
}

export function maxMp(ctx: Ctx, a: ActorInstance): number {
  return Math.max(0, a.maxMp + modSum(ctx, a, 'mp'));
}

export function sightRadius(ctx: Ctx, a: ActorInstance): number {
  if (hasFlag(ctx, a, 'blinded')) return 1;
  let v = a.base.sight + modSum(ctx, a, 'sight');
  v = Math.round(v * switchesOf(ctx).darkness);
  let light = 0;
  for (const m of a.tempMods) if (m.stat === 'light') light = Math.max(light, m.amount);
  return Math.max(1, v, light);
}

/** energy gained per round */
export function energyGain(ctx: Ctx, a: ActorInstance): number {
  let v = Math.max(10, a.base.speed + modSum(ctx, a, 'speed'));
  if (hasFlag(ctx, a, 'hasted')) v *= 2;
  if (hasFlag(ctx, a, 'slowed')) v *= 0.5;
  return Math.max(10, Math.round(v));
}

/** read any StatRef on an actor */
export function getStat(ctx: Ctx, a: ActorInstance, stat: string): number {
  switch (stat) {
    case 'hp':
      return a.hp;
    case 'mp':
      return a.mp;
    case 'str':
    case 'dex':
    case 'int':
      return Math.max(1, a.base[stat] + modSum(ctx, a, stat));
    case 'ac':
      return Math.max(0, a.base.ac + modSum(ctx, a, 'ac'));
    case 'speed':
      return Math.max(10, a.base.speed + modSum(ctx, a, 'speed'));
    case 'sight':
      return sightRadius(ctx, a);
    default:
      if (isPlayer(ctx, a)) return ctx.s.player.resources[stat] ?? 0;
      return 0;
  }
}

export function getMax(ctx: Ctx, a: ActorInstance, stat: string): number {
  if (stat === 'hp') return maxHp(ctx, a);
  if (stat === 'mp') return maxMp(ctx, a);
  const r = ctx.ix.resources.get(stat);
  if (r) return r.max;
  return getStat(ctx, a, stat);
}

export function side(ctx: Ctx, a: ActorInstance): Side {
  if (isPlayer(ctx, a) || a.faction === 'player' || a.allyOf) return 'P';
  if (a.faction === 'hostile') return 'H';
  if (a.faction === 'friendly') return 'F';
  return 'N';
}

export function isEnemy(ctx: Ctx, a: ActorInstance, b: ActorInstance): boolean {
  if (a === b) return false;
  const sa = side(ctx, a);
  const sb = side(ctx, b);
  return (sa === 'P' && sb === 'H') || (sa === 'H' && sb === 'P');
}

export function isAlly(ctx: Ctx, a: ActorInstance, b: ActorInstance): boolean {
  if (a === b) return true;
  const sa = side(ctx, a);
  return sa === side(ctx, b) && sa !== 'N';
}
