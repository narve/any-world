/**
 * Item knowledge: per-run appearances for unknown items, learning on use (revealOnUse),
 * identify effects and the player's notes about what an item did.
 */
import type { ItemDef, Knowledge } from '../schema/world';
import type { ItemKnowledgeState } from './types';
import type { SeededRng } from './rng';
import type { WorldSpec } from '../schema/world';
import { type Ctx, emit, itemName, logKey, statName, statusName } from './ctx';
import type { Obs } from './effects';
import { indexWorld } from './ctx';
import { own } from './util';

const RANK: Record<Knowledge, number> = { unknown: 0, vague: 1, clear: 2 };
export const MAX_NOTES = 6;

export function initialKnowledge(world: WorldSpec, def: ItemDef): Knowledge {
  if (def.knowledge === 'clear' && indexWorld(world).switches.allConsumablesUnknown && def.category === 'consumable') return 'unknown';
  return def.knowledge;
}

const FALLBACK_ADJECTIVES = ['unfamiliar', 'strange', 'curious', 'odd', 'peculiar', 'unmarked', 'puzzling', 'nameless'];

function fallbackAppearance(def: ItemDef, taken?: Set<string>): { label: string; color: string } {
  const kind = def.kind.toLowerCase();
  const color = def.model.colors?.primary ?? def.model.humanoid?.top ?? def.model.parts[0]?.color ?? '#9a9a9a';
  let label = `unfamiliar ${kind}`;
  if (taken) {
    // different unknown items of the same kind must not share a label (that would identify by elimination
    // nothing and confuse everything); try adjectives, then numbers
    const cands = FALLBACK_ADJECTIVES.map((a) => `${a} ${kind}`);
    label = cands.find((c) => !taken.has(c.toLowerCase())) ?? '';
    for (let n = 2; !label; n++) if (!taken.has(`unfamiliar ${kind} ${n}`)) label = `unfamiliar ${kind} ${n}`;
    taken.add(label.toLowerCase());
  }
  return { label, color };
}

/** builds the knowledge table; assigns each unknown item a distinct random appearance from its group */
export function initKnowledge(world: WorldSpec, rng: SeededRng): Record<string, ItemKnowledgeState> {
  const out: Record<string, ItemKnowledgeState> = {};
  const pools = new Map<string, { label: string; color: string }[]>();
  for (const [g, list] of Object.entries(world.unknownAppearances ?? {})) pools.set(g, rng.shuffle(list.map((x) => ({ ...x }))));
  const taken = new Set<string>();
  const needFallback: ItemDef[] = [];
  for (const def of world.items) {
    const level = initialKnowledge(world, def);
    const st: ItemKnowledgeState = { level, notes: [], timesUsed: 0 };
    // hidden by the world's allConsumablesUnknown rule: comes back if the GM lifts that rule
    if (level !== def.knowledge) st.ruleHidden = true;
    if (level !== 'clear') {
      const pool = def.appearanceGroup ? pools.get(def.appearanceGroup) : undefined;
      if (pool && pool.length) {
        st.appearance = pool.shift()!;
        taken.add(st.appearance.label.toLowerCase());
      } else needFallback.push(def);
    }
    out[def.id] = st;
  }
  for (const def of needFallback) out[def.id].appearance = fallbackAppearance(def, taken);
  return out;
}

/**
 * An allConsumablesUnknown rule came into force mid-run (GM add_rule): every consumable the player
 * knows only from the world (never used it, not carrying it) becomes unknown again and gets a
 * per-run appearance, drawn from its appearance group's pool like at run start (labels already in
 * use are skipped; the fallback "unfamiliar <kind>" names are kept distinct). Silent: the rule's
 * own announcement says what happened. Returns the def ids hidden.
 */
export function hideConsumablesForRule(ctx: Ctx): string[] {
  const carried = new Set(ctx.s.player.slots.filter((it) => !!it).map((it) => it!.defId));
  const taken = new Set<string>();
  for (const k of Object.values(ctx.s.knowledge)) if (k.appearance) taken.add(k.appearance.label.toLowerCase());
  const pools = new Map<string, { label: string; color: string }[]>();
  const poolFor = (g: string | undefined) => {
    if (!g) return undefined;
    let p = pools.get(g);
    if (!p) {
      const list = (ctx.world.unknownAppearances ?? {})[g] ?? [];
      p = ctx.rng.shuffle(list.filter((x) => !taken.has(x.label.toLowerCase())).map((x) => ({ ...x })));
      pools.set(g, p);
    }
    return p;
  };
  const hidden: string[] = [];
  const needFallback: ItemDef[] = [];
  for (const def of ctx.world.items) {
    if (def.category !== 'consumable' || def.knowledge !== 'clear' || carried.has(def.id)) continue;
    const k = knowledgeOf(ctx, def.id);
    if (k.level !== 'clear' || k.timesUsed > 0 || k.ruleHidden) continue;
    k.level = 'unknown';
    k.ruleHidden = true;
    hidden.push(def.id);
    if (k.appearance) continue;
    const pool = poolFor(def.appearanceGroup);
    const pick = pool?.find((x) => !taken.has(x.label.toLowerCase()));
    if (pick && pool) {
      pool.splice(pool.indexOf(pick), 1);
      k.appearance = pick;
      taken.add(pick.label.toLowerCase());
    } else needFallback.push(def);
  }
  for (const def of needFallback) ctx.s.knowledge[def.id].appearance = fallbackAppearance(def, taken);
  for (const id of hidden) emit(ctx, { type: 'item_identified', defId: id, level: 'unknown' });
  return hidden;
}

/**
 * No allConsumablesUnknown rule is in force any more: what hideConsumablesForRule hid goes back
 * to the item's own knowledge level (what the player learned meanwhile is kept). Returns the def
 * ids restored.
 */
export function unhideConsumablesForRule(ctx: Ctx): string[] {
  const restored: string[] = [];
  for (const [id, k] of Object.entries(ctx.s.knowledge)) {
    if (!k.ruleHidden) continue;
    delete k.ruleHidden;
    const own = ctx.ix.items.get(id)?.knowledge ?? 'clear';
    if (RANK[own] > RANK[k.level]) {
      k.level = own;
      restored.push(id);
      emit(ctx, { type: 'item_identified', defId: id, level: own });
    }
  }
  return restored;
}

export function knowledgeOf(ctx: Ctx, defId: string): ItemKnowledgeState {
  let k = own(ctx.s.knowledge, defId);
  if (!k) {
    const def = ctx.ix.items.get(defId);
    k = { level: def ? initialKnowledge(ctx.world, def) : 'clear', notes: [], timesUsed: 0 };
    if (def && k.level !== 'clear') k.appearance = fallbackAppearance(def);
    ctx.s.knowledge[defId] = k;
  }
  return k;
}

/** raises knowledge to `level` (never lowers it); returns true if it changed */
export function reveal(ctx: Ctx, defId: string, level: Knowledge, announce = true): boolean {
  const k = knowledgeOf(ctx, defId);
  if (RANK[level] <= RANK[k.level]) return false;
  const before = k.level;
  k.level = level;
  emit(ctx, { type: 'item_identified', defId, level });
  if (announce) {
    const def = ctx.ix.items.get(defId);
    if (before === 'unknown' && k.appearance) {
      logKey(ctx, level === 'vague' ? 'log.identify.appearance_vague' : 'log.identify.appearance', { appearance: k.appearance.label, item: def?.name ?? defId }, 'good');
    } else {
      logKey(ctx, 'log.identify.understand', { item: itemName(ctx, defId) }, 'good');
    }
  }
  return true;
}

/** identify effect: one (first not-clear carried item) or all carried */
export function identifyCarried(ctx: Ctx, scope: 'one' | 'all_carried'): number {
  let n = 0;
  const seen = new Set<string>();
  for (const it of ctx.s.player.slots) {
    if (!it || seen.has(it.defId)) continue;
    seen.add(it.defId);
    if (knowledgeOf(ctx, it.defId).level === 'clear') continue;
    if (reveal(ctx, it.defId, 'clear')) n++;
    if (scope === 'one' && n > 0) break;
  }
  return n;
}

/** knowledge update after the player used an item, plus a note about what happened */
export function learnFromUse(ctx: Ctx, def: ItemDef, obs: Obs[], conditionFailed = false): void {
  const k = knowledgeOf(ctx, def.id);
  k.timesUsed += 1;
  if (def.revealOnUse === 'full') reveal(ctx, def.id, 'clear');
  else if (def.revealOnUse === 'vague') reveal(ctx, def.id, 'vague');
  const precise = k.level === 'clear';
  const note = conditionFailed ? 'Nothing obvious happened.' : describeObservations(ctx, obs, precise);
  if (!k.notes.includes(note)) {
    k.notes.push(note);
    if (k.notes.length > MAX_NOTES) k.notes.splice(0, k.notes.length - MAX_NOTES);
  }
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** a short human sentence about what the player observed; numbers only when `precise` */
export function describeObservations(ctx: Ctx, obs: Obs[], precise: boolean): string {
  const parts: string[] = [];
  const add = (s: string) => {
    if (!parts.includes(s)) parts.push(s);
  };
  const hpName = statName(ctx, 'hp');
  // aggregate self heal/hurt
  const selfHeal = obs.filter((o) => o.kind === 'heal' && o.self).reduce((s, o) => s + (o.amount ?? 0), 0);
  const selfHurt = obs.filter((o) => o.kind === 'hurt' && o.self).reduce((s, o) => s + (o.amount ?? 0), 0);
  if (selfHeal > 0) add(precise ? `You felt better (+${selfHeal} ${hpName})` : 'You felt better');
  if (selfHurt > 0) add(precise ? `It hurt you (-${selfHurt} ${hpName})` : 'It hurt you');
  for (const o of obs) {
    switch (o.kind) {
      case 'hurt':
        if (!o.self && (o.amount ?? 0) > 0) add(precise ? `It hurt ${o.who} (-${o.amount})` : `It hurt ${o.who}`);
        break;
      case 'heal':
        if (!o.self && (o.amount ?? 0) > 0) add(precise ? `${o.who} recovered (+${o.amount})` : `${o.who} recovered`);
        break;
      case 'resource':
        if (o.self && o.amount) {
          const nm = statName(ctx, o.label ?? '');
          add(precise ? `${nm} ${signed(o.amount)}` : `Your ${nm} ${o.amount > 0 ? 'rose' : 'fell'}`);
        }
        break;
      case 'stat':
        if (o.self && o.amount) {
          const nm = statName(ctx, o.label ?? '');
          add(precise ? `${nm} ${signed(o.amount)}` : 'You felt different');
        }
        break;
      case 'status':
        add(o.self ? `You became ${statusName(ctx, o.label ?? '')}${precise && o.amount ? ` (${o.amount} turns)` : ''}` : `${o.who} became ${statusName(ctx, o.label ?? '')}`);
        break;
      case 'status_removed':
        if (o.self) add(`${statusName(ctx, o.label ?? '')} went away`);
        break;
      case 'teleport':
        add(o.self ? 'You were moved somewhere else' : `${o.who} was moved somewhere else`);
        break;
      case 'moved':
        add(o.self ? 'You were shoved' : `${o.who} was shoved`);
        break;
      case 'summon':
        add('Something appeared');
        break;
      case 'terrain':
        add('The surroundings changed');
        break;
      case 'item':
        add('Something appeared on the ground');
        break;
      case 'reveal':
        add('You got a sense of the layout');
        break;
      case 'identify':
        add('You understood your belongings better');
        break;
      case 'light':
        add(precise ? `It gave light (radius ${o.amount})` : 'It gave light');
        break;
      case 'noise':
        add('It was loud');
        break;
      case 'xp':
        add(precise ? `+${o.amount} ${ctx.world.vocabulary.xp}` : 'You learned something');
        break;
      case 'faction':
        add(`${o.who} changed sides`);
        break;
      case 'transform':
        add(`${o.who} changed shape`);
        break;
    }
  }
  if (!parts.length) return 'Nothing obvious happened.';
  return parts.join('; ') + '.';
}
