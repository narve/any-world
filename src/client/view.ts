/**
 * Pure builders: GameState + WorldSpec (+ controller-side extras) → the UI view model. No DOM, no
 * renderer, so everything here is unit-tested in node (tests/client/view.test.ts).
 */
import type { WorldSpec, ItemDef, Perk, Effect } from '../schema/world';
import type { GameState, ItemView, LogMessage, PendingChoice, PlayerAction } from '../engine/types';
import { QUICK_SLOTS, TOTAL_SLOTS } from '../engine/types';
import { parseDice } from '../engine/rng';
import {
  leadPlayer,
  describeInventory,
  describeItemDef,
  endingText,
  legalActions,
  playerSheet,
  transitionBlocker,
  type PlayerSheet,
} from '../engine/index';
import { activeRulesOf, type RuleTracker } from './rules';
import { contextActions, goalView, inWorldLanguage, worldTextLanguage } from './guide';
import { logTextIn } from './i18n/prompt-log';
import { catalog, formatMessage, listJoin, t, tx } from './i18n/index';
import { dialogueOptionLabel, npcRoleLabel } from './i18n/engine-text';
import type {
  ChoiceView,
  DangerView,
  DialogueView,
  EndView,
  GameView,
  HudView,
  LevelUpView,
  NarrationView,
  OnboardingView,
  PaletteView,
  QuestView,
  RuleView,
  SlotItemView,
  StatusChipView,
  ThemeView,
  TradeView,
} from './ui/viewmodel';

/**
 * HP below this fraction is dangerous: the HUD warns, a red vignette rims the screen and a healing
 * item glows (35 %: the HUD badge alone was easy to miss, FABLE-GAMEPLAY-REVIEW.md §1.5)
 */
export const HP_DANGER = 0.35;
/** a custom resource below this fraction is low */
export const RESOURCE_DANGER = 0.25;

/** durability every item starts with when the durability rule is on (engine DEFAULT_DURABILITY) */
const MAX_DURABILITY = 40;
const LOG_LIMIT = 120;
const POSITIONAL = new Set(['single', 'ray', 'cone', 'area']);

export function themeOf(world: WorldSpec): ThemeView {
  const palette: PaletteView = { ...world.palette };
  return { palette, vocabulary: world.vocabulary };
}

export function playerOf(state: GameState) {
  const p = state.area.actors.find((a) => a.id === leadPlayer(state).actorId);
  if (!p) throw new Error('player actor missing');
  return p;
}

function equipSlotOf(def: ItemDef): SlotItemView['equipSlot'] {
  if (def.equipSlot) return def.equipSlot;
  if (def.category === 'weapon' && def.weapon) return 'weapon';
  if (def.category === 'armour') return 'armour';
  return undefined;
}

/**
 * XP shown on the player card. While a perk choice is open the engine holds further level-ups, so
 * the stored xp can exceed the current threshold ("175 / 38"). The bar is clamped to the threshold
 * and the queued level-ups are counted instead (issues/M2-xp-bar-overflow.md). Thresholds after the
 * first follow the engine's curve (engine/progression.ts xpToNext).
 */
export function xpProgress(
  world: WorldSpec,
  level: number,
  xp: number,
  need: number,
): { xpInLevel: number; xpForLevel: number; pendingLevels?: number } {
  const g = world.player.growth;
  const threshold = (lv: number) => Math.max(1, Math.round(g.firstLevelXp * Math.pow(g.curve, Math.max(0, lv - 1))));
  const first = Math.max(1, need);
  if (xp < first) return { xpInLevel: Math.max(0, xp), xpForLevel: first };
  let left = xp;
  let lv = level;
  let pending = 0;
  let next = first;
  while (left >= next && pending < 100) {
    left -= next;
    pending += 1;
    lv += 1;
    next = threshold(lv);
  }
  return { xpInLevel: first, xpForLevel: first, pendingLevels: pending };
}

/** activating this item asks the player for a target tile */
export function needsTarget(def: ItemDef): boolean {
  const u = def.onUse;
  if (!u || def.useMode === 'passive') return false;
  return POSITIONAL.has(u.targeting.shape) && u.targeting.affects !== 'self_only';
}

/** the item is aimed by direction (a ray or cone from the user), not at a tile */
export function aimsDirection(def: ItemDef): boolean {
  const t = def.onUse?.targeting;
  return !!t && needsTarget(def) && (t.shape === 'ray' || t.shape === 'cone');
}

/**
 * When using `def` now would do nothing because everything it restores is already full, the name of
 * the full vital(s) ("O2", "Health and O2"); else null. Only for items that purely restore (heal /
 * positive resource / message effects, and cures for conditions the user does not have, aimed at
 * the user) — anything with another effect may still be wanted
 * (issues/M2-consumable-wasted-when-full.md).
 */
export function wastedRestore(world: WorldSpec, def: ItemDef, sheet: PlayerSheet, statuses: readonly { id: string }[] = []): string | null {
  const u = def.onUse;
  if (!u || def.useMode === 'passive' || u.condition) return null;
  if (!(u.targeting.affects === 'self_only' || u.targeting.shape === 'self')) return null;
  const names: string[] = [];
  const add = (n: string) => {
    if (!names.includes(n)) names.push(n);
  };
  let restores = false;
  const harmful = new Set(world.statuses.filter((x) => x.harmful).map((x) => x.id));
  for (const e of u.effects) {
    if (e.type === 'message') continue;
    if (e.type === 'remove_status') {
      const cures = e.status === 'all_harmful' ? statuses.some((x) => harmful.has(x.id)) : statuses.some((x) => x.id === e.status);
      if (cures) return null;
      continue;
    }
    if (e.type === 'heal' && positive(e.amount)) {
      restores = true;
      if (sheet.hp < sheet.maxHp) return null;
      add(world.vocabulary.stats.hp.name);
      continue;
    }
    if (e.type === 'resource' && positive(e.amount)) {
      restores = true;
      if (e.resource === 'mp') {
        if (sheet.maxMp <= 0 || sheet.mp < sheet.maxMp) return null;
        add(world.vocabulary.stats.mp.name);
        continue;
      }
      const r = sheet.resources.find((x) => x.id === e.resource);
      if (!r || r.value < r.max) return null;
      add(world.resources.find((x) => x.id === e.resource)?.name ?? e.resource);
      continue;
    }
    return null;
  }
  if (!restores) return null;
  return listJoin(names, 'and');
}

export function hudView(world: WorldSpec, state: GameState, sheet: PlayerSheet): HudView {
  const p = playerOf(state);
  const statusIx = new Map(world.statuses.map((s) => [s.id, s]));
  const statuses: StatusChipView[] = p.statuses.map((s) => {
    const d = statusIx.get(s.id);
    return {
      id: s.id,
      name: d?.name ?? s.id,
      description: d?.description ?? '',
      harmful: d?.harmful ?? false,
      color: d?.color ?? '#9aa0aa',
      turnsLeft: s.turnsLeft,
    };
  });
  const plan = world.areas[state.area.index];
  const base = p.base;
  return {
    playerName: world.player.name,
    playerTitle: world.player.title,
    playerColor: world.player.model.humanoid?.top ?? world.player.model.colors?.primary,
    stats: [
      { key: 'str', value: sheet.str, base: base.str },
      { key: 'dex', value: sheet.dex, base: base.dex },
      { key: 'int', value: sheet.int, base: base.int },
      { key: 'ac', value: sheet.ac, base: base.ac },
    ],
    hp: { value: Math.max(0, sheet.hp), max: sheet.maxHp },
    mp: sheet.maxMp > 0 ? { value: sheet.mp, max: sheet.maxMp } : null,
    resources: world.resources.map((r) => {
      const v = sheet.resources.find((x) => x.id === r.id);
      const value = v?.value ?? 0;
      return { id: r.id, label: r.name, description: r.description, value, max: r.max, color: r.color, ...(value < r.max * RESOURCE_DANGER ? { low: true } : {}) };
    }),
    level: leadPlayer(state).level,
    ...xpProgress(world, leadPlayer(state).level, sheet.xp, sheet.xpToNext),
    currency: state.purse,
    statuses,
    areaName: plan?.name ?? '',
    areaIndex: state.area.index,
    areaCount: world.areas.length,
    turn: state.turn,
    sneaking: leadPlayer(state).sneaking,
    speed: sheet.speed >= 115 ? 'fast' : sheet.speed <= 85 ? 'slow' : 'normal',
    danger: dangerOf(world, state, sheet),
  };
}

/** does running out of this resource hurt (onEmpty damage, a damaging harmful status, or death)? */
function emptyHurts(world: WorldSpec, r: WorldSpec['resources'][number]): boolean {
  if (r.emptyIsDeath) return true;
  const statuses = new Map(world.statuses.map((s) => [s.id, s]));
  return r.onEmpty.some((e) => {
    if (e.type === 'damage') return true;
    if (e.type !== 'apply_status') return false;
    const st = statuses.get(e.status);
    return !!st && st.harmful && st.perTurn.some((x) => x.type === 'damage' || (x.type === 'resource' && x.resource === 'hp'));
  });
}

/** low and empty vitals, most urgent first (slot is filled in by gameView) */
export function dangerOf(world: WorldSpec, state: GameState, sheet: PlayerSheet): DangerView[] {
  const out: DangerView[] = [];
  const hp = world.vocabulary.stats.hp;
  if (sheet.maxHp > 0 && sheet.hp < sheet.maxHp * HP_DANGER) {
    out.push({ id: 'hp', label: hp.name, color: world.palette.danger, level: sheet.hp <= 0 ? 'empty' : 'low', draining: true });
  }
  for (const r of world.resources) {
    const v = leadPlayer(state).resources[r.id] ?? 0;
    if (v >= r.max * RESOURCE_DANGER) continue;
    const empty = v <= 0;
    // only vitals: something that hurts when empty, or drains by itself
    if (!emptyHurts(world, r) && !(r.perTurn < 0)) continue;
    out.push({ id: r.id, label: r.name, color: r.color, level: empty ? 'empty' : 'low', draining: empty && emptyHurts(world, r) });
  }
  return out.sort((a, b) => Number(b.draining) - Number(a.draining) || (a.level === b.level ? 0 : a.level === 'empty' ? -1 : 1));
}

function positive(a: { base?: number; dice?: string }): boolean {
  return (a.base ?? 0) > 0 || (!!a.dice && (a.base ?? 0) >= 0);
}

/** vitals an item's use restores ('hp', 'mp', resource ids) — from its definition */
export function restoresOf(def: ItemDef): string[] {
  const u = def.onUse;
  if (!u || def.useMode === 'passive') return [];
  if (!(u.targeting.affects === 'self_only' || u.targeting.shape === 'self')) return [];
  const out = new Set<string>();
  const visit = (e: Effect) => {
    if (e.type === 'heal' && positive(e.amount)) out.add('hp');
    if (e.type === 'resource' && positive(e.amount)) out.add(e.resource);
  };
  u.effects.forEach(visit);
  return [...out];
}

/** expected damage an item's use deals to enemies (0 = not an attack item) */
export function attackPower(def: ItemDef): number {
  const u = def.onUse;
  if (!u || def.useMode === 'passive' || def.weapon) return 0;
  if (u.targeting.affects !== 'enemies' && u.targeting.affects !== 'all') return 0;
  let n = 0;
  for (const e of u.effects) {
    if (e.type !== 'damage') continue;
    const d = parseDice(e.amount.dice);
    n += Math.max(0, (e.amount.base ?? 0) + (d ? (d[0] * (d[1] + 1)) / 2 : 0) + (e.amount.scale ? e.amount.scale.factor * 12 : 0));
  }
  // an area or a cone may hit several
  return u.targeting.shape === 'area' || u.targeting.shape === 'cone' || u.targeting.shape === 'all_visible' ? n * 1.5 : n;
}

/** combat lines in this many recent turns make "a fight" */
const FIGHT_TURNS = 3;

/**
 * Quick slots worth pressing now (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §1.4, §3.6):
 *  - after two or more of the last three turns were spent fighting someone hostile next to the
 *    player, the strongest attack item that is ready (fights that cost 15+ HP ended in one turn
 *    with an item that sat unused);
 *  - an equipped ranged weapon while someone hostile is in its reach but not adjacent (its key
 *    aims it; bumping only works next to them).
 */
export function strongMoveSlots(world: WorldSpec, state: GameState, slots: (SlotItemView | null)[], legal: readonly PlayerAction[]): number[] {
  if (state.status !== 'playing' || leadPlayer(state).pendingChoice) return [];
  const p = state.area.actors.find((a) => a.id === leadPlayer(state).actorId);
  if (!p) return [];
  const seen = leadPlayer(state).seen as ArrayLike<number>;
  const W = state.area.map.width;
  const hostiles = state.area.actors.filter((a) => a.hp > 0 && a.faction === 'hostile' && !a.allyOf && seen[a.pos.y * W + a.pos.x] === 2);
  const near = (a: { pos: { x: number; y: number } }) => Math.max(Math.abs(a.pos.x - p.pos.x), Math.abs(a.pos.y - p.pos.y));
  const out: number[] = [];
  const defs = new Map(world.items.map((i) => [i.id, i]));
  const quick = slots.slice(0, QUICK_SLOTS);
  if (hostiles.some((h) => near(h) <= 1)) {
    const turns = new Set(state.log.filter((m) => m.kind === 'combat' && m.turn > state.turn - FIGHT_TURNS).map((m) => m.turn));
    if (turns.size >= 2) {
      let best = -1;
      let bestPower = 0;
      quick.forEach((sv, i) => {
        const def = sv && sv.knowledge !== 'unknown' && readyToUse(sv) ? defs.get(sv.defId) : undefined;
        const power = def ? attackPower(def) : 0;
        if (power > bestPower) {
          bestPower = power;
          best = i;
        }
      });
      if (best >= 0) out.push(best);
    }
  } else {
    const w = leadPlayer(state).equipped.weapon;
    const sv = w !== null && w < QUICK_SLOTS ? quick[w] : null;
    if (sv?.range && hostiles.some((h) => near(h) > 1 && legal.some((a) => a.type === 'attack' && a.targetId === h.id))) out.push(w!);
  }
  return out;
}

/** pressing this slot would use the item right now (no cooldown, charges left, usable) */
export function readyToUse(sv: SlotItemView): boolean {
  if (!sv.usable) return false;
  if (sv.cooldown && sv.cooldown > 0) return false;
  if (sv.maxCharges && (sv.charges ?? 0) <= 0) return false;
  return true;
}

export function slotViews(world: WorldSpec, state: GameState, views: (ItemView | null)[]): (SlotItemView | null)[] {
  const defs = new Map(world.items.map((i) => [i.id, i]));
  const out: (SlotItemView | null)[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const it = leadPlayer(state).slots[i];
    const v = views[i];
    if (!it || !v) {
      out.push(null);
      continue;
    }
    const def = defs.get(it.defId);
    const sv: SlotItemView = { ...v, instanceId: it.id, defId: it.defId, stackable: !!def?.stackable };
    if (def) {
      if (def.useMode === 'charges' && def.charges) sv.maxCharges = def.charges;
      if (def.cooldown > 0) sv.maxCooldown = def.cooldown;
      const es = equipSlotOf(def);
      if (es) sv.equipSlot = es;
      sv.needsTarget = needsTarget(def);
      if (aimsDirection(def)) sv.aimsDirection = true;
      if (def.weapon && def.weapon.range > 1) sv.range = def.weapon.range;
      sv.rarity = def.rarity;
      // what it restores is only shown when the player knows what it does
      if (v.knowledge === 'clear') {
        const r = restoresOf(def);
        if (r.length) sv.restores = r;
      }
    }
    if (it.cooldown) sv.cooldown = it.cooldown;
    if (it.durability !== undefined) {
      sv.durability = it.durability;
      sv.maxDurability = Math.max(MAX_DURABILITY, it.durability);
    }
    out.push(sv);
  }
  return out;
}

/** how the engine's pending dialogue choice maps onto the dialogue panel */
export interface DialogueMap {
  /** labels shown as reply options */
  labels: string[];
  /** engine option index for each label */
  engineIndex: number[];
  /** engine option index of "goodbye" (no actions, no tag), if any */
  leaveIndex: number | null;
  /** engine option indices of trader 'buy' offers */
  buy: number[];
  /** engine option indices of the trader's 'sell' offers (they buy from the player) */
  sell: number[];
}

/** a dialogue option the session hides from the reply list (e.g. "Ask what they know" once heard out) */
export type DialogueSkip = (option: PendingChoice['options'][number], index: number) => boolean;

export function dialogueMap(pc: PendingChoice, skip?: DialogueSkip): DialogueMap {
  const m: DialogueMap = { labels: [], engineIndex: [], leaveIndex: null, buy: [], sell: [] };
  pc.options.forEach((o, i) => {
    if (skip?.(o, i)) return;
    if (o.tag === 'buy') m.buy.push(i);
    else if (o.tag === 'sell') m.sell.push(i);
    else if (!o.tag && o.actions.length === 0 && m.leaveIndex === null && i === pc.options.length - 1) m.leaveIndex = i;
    else if (m.labels.length < 3) {
      m.labels.push(o.label);
      m.engineIndex.push(i);
    }
  });
  return m;
}

export function dialogueView(
  world: WorldSpec,
  state: GameState,
  history: { who: 'npc' | 'player'; text: string }[],
  skip?: DialogueSkip,
): DialogueView | null {
  const pc = leadPlayer(state).pendingChoice;
  if (!pc || pc.kind !== 'dialogue') return null;
  const npc = state.area.actors.find((a) => a.id === pc.speakerId);
  const def = npc ? world.actors.find((d) => d.id === npc.defId) : undefined;
  const m = dialogueMap(pc, skip);
  return {
    npcId: pc.speakerId ?? '',
    npcName: def?.name ?? t('common.someone'),
    npcTitle: def?.npc ? npcRoleLabel(def.npc.role) : undefined,
    portraitColor: def?.model.humanoid?.top ?? def?.model.colors?.primary ?? world.palette.accent,
    reply: pc.prompt,
    options: m.engineIndex.map((i) => dialogueOptionLabel(pc.options[i]!)),
    pending: false,
    canPersuade: !!world.verbs.persuade && !!npc && !npc.allyOf,
    canTrade: m.buy.length > 0 || m.sell.length > 0,
    history: history.slice(-6),
  };
}

export function choiceView(world: WorldSpec, state: GameState): ChoiceView | null {
  const pc = leadPlayer(state).pendingChoice;
  if (!pc || pc.kind !== 'gm_offer') return null;
  const npc = pc.speakerId ? state.area.actors.find((a) => a.id === pc.speakerId) : undefined;
  const def = npc ? world.actors.find((d) => d.id === npc.defId) : undefined;
  return { prompt: pc.prompt, speaker: def?.name, options: pc.options.map((o) => ({ label: dialogueOptionLabel(o) })) };
}

function statLabel(world: WorldSpec, stat: string): string {
  const v = world.vocabulary.stats as Record<string, { name: string }>;
  if (v[stat]) return v[stat].name;
  const r = world.resources.find((x) => x.id === stat);
  if (r) return r.name;
  if (stat === 'speed') return t('stat.speed');
  if (stat === 'sight') return t('stat.sight');
  return stat;
}

export function perkLines(world: WorldSpec, perk: Perk): string[] {
  const lines = perk.modifiers.map((m) => `${m.amount >= 0 ? '+' : ''}${m.amount} ${statLabel(world, m.stat)}`);
  for (const id of perk.grantItems) {
    const it = world.items.find((i) => i.id === id);
    if (it) lines.push(t('perk.gain', { item: it.name }));
  }
  return lines;
}

export function levelUpView(world: WorldSpec, state: GameState): LevelUpView | null {
  const ids = leadPlayer(state).pendingPerkChoice;
  if (!ids || !ids.length) return null;
  const perks = ids
    .map((id) => world.player.growth.perks.find((p) => p.id === id))
    .filter((p): p is Perk => !!p)
    .map((p) => ({ id: p.id, name: p.name, description: p.description, lines: perkLines(world, p) }));
  return { level: leadPlayer(state).level, perks };
}

export function tradeView(world: WorldSpec, state: GameState): TradeView | null {
  const pc = leadPlayer(state).pendingChoice;
  if (!pc || pc.kind !== 'dialogue') return null;
  const m = dialogueMap(pc);
  if (!m.buy.length && !m.sell.length) return null;
  const npc = state.area.actors.find((a) => a.id === pc.speakerId);
  const def = npc ? world.actors.find((d) => d.id === npc.defId) : undefined;
  const offers = m.buy.map((i) => {
    const o = pc.options[i];
    const give = o.actions.find((a) => a.type === 'give_item') as { item: string } | undefined;
    const price = o.actions.reduce((n, a) => n + (a.type === 'currency' && a.amount < 0 ? -a.amount : 0), 0);
    const item = give ? describeItemDef(state, give.item) : fallbackItemView(o.label);
    return { item, price };
  });
  return {
    traderId: pc.speakerId ?? '',
    traderName: def?.name ?? t('trade.trader'),
    traderColor: def?.model.humanoid?.top ?? def?.model.colors?.primary ?? world.palette.accent,
    greeting: pc.prompt,
    currency: state.purse,
    offers,
    sellable: sellableOf(world, state, pc, m),
  };
}

/** the trader's sell offers (tag 'sell'): one unit of a carried item each, at a positive price */
function sellableOf(world: WorldSpec, state: GameState, pc: PendingChoice, m: DialogueMap): TradeView['sellable'] {
  if (!m.sell.length) return [];
  const slots = slotViews(world, state, describeInventory(state));
  const out: TradeView['sellable'] = [];
  for (const i of m.sell) {
    const o = pc.options[i];
    if (!o.sell) continue;
    const item = slots[o.sell.slot];
    if (!item || item.defId !== o.sell.defId) continue;
    const price = o.actions.reduce((n, a) => n + (a.type === 'currency' && a.amount > 0 ? a.amount : 0), 0);
    out.push({ slot: o.sell.slot, item, price });
  }
  return out;
}

function fallbackItemView(label: string): ItemView {
  return { name: label, kind: '', description: '', knowledge: 'clear', effectLines: [], notes: [], count: 1, equipped: false, usable: false, color: '#888888' };
}

/** "from the start" or "<Area word> N, turn T" */
export function sinceLabel(world: WorldSpec, area?: number, turn?: number): string {
  if (turn === undefined) return t('rules.fromStart');
  return area !== undefined ? t('rules.sinceAreaTurn', { area: world.vocabulary.area, n: area + 1, turn }) : t('rules.sinceTurn', { turn });
}

/** the rules in force (world + GM), with since-when and the GM's reason */
export function rulesView(world: WorldSpec, state?: GameState, tracker?: RuleTracker): RuleView[] {
  if (!state) return world.rules.map((r) => ({ id: r.id, name: r.name, description: r.description, since: t('rules.fromStart') }));
  return activeRulesOf(world, state).map((r) => {
    const memo = tracker?.memoFor(r.rule.id);
    const turn = r.sinceTurn ?? memo?.sinceTurn;
    const area = r.sinceArea ?? memo?.sinceArea;
    const reason = r.reason ?? memo?.reason;
    const v: RuleView = { id: r.rule.id, name: r.rule.name, description: r.rule.description, since: sinceLabel(world, area, turn) };
    if (r.source === 'gm') v.fromGm = true;
    if (reason) v.reason = reason;
    if (memo?.newUntil !== undefined && memo.newUntil >= state.turn) v.isNew = true;
    return v;
  });
}

/**
 * The objective under the area banner, in two parts: the goal (the open thread if there is one,
 * else the world goal) and where to go next in this area. They are shown on separate lines so the
 * actionable hint is never the part an ellipsis hides (issues/M2-objective-hint-truncated.md).
 */
export function objectiveParts(world: WorldSpec, state: GameState, canTransition: boolean): { goal: string; hint: string | null } {
  const quest = state.quests.find((q) => q.status === 'active');
  const goal = quest ? quest.title : world.goal.summary;
  const plan = world.areas[state.area.index];
  const last = state.area.index >= world.areas.length - 1;
  if (!plan || last) return { goal, hint: null };
  if (canTransition) return { goal, hint: t('objective.press', { way: lowerFirst(plan.transitionName) }) };
  const ex = state.area.map.exit;
  const seen = (leadPlayer(state).seen as ArrayLike<number>)[ex.y * state.area.map.width + ex.x] ?? 0;
  return { goal, hint: seen ? t('objective.marked', { way: plan.transitionName }) : t('objective.find', { area: plan.name }) };
}

function objectiveFields(o: { goal: string; hint: string | null }): Pick<GameView, 'objective' | 'objectiveHint'> {
  return o.hint ? { objective: o.goal, objectiveHint: o.hint } : { objective: o.goal };
}

/** the objective as one line (goal — hint), e.g. for logs and tooltips */
export function objectiveOf(world: WorldSpec, state: GameState, canTransition: boolean): string {
  const { goal, hint } = objectiveParts(world, state, canTransition);
  return hint ? `${goal} — ${lowerFirst(hint)}` : goal;
}

function lowerFirst(s: string): string {
  return s && s[0] === s[0].toUpperCase() && s.slice(1, 2) !== s.slice(1, 2).toUpperCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

export function questsView(state: GameState): QuestView[] {
  return state.quests.map((q) => ({ id: q.id, title: q.title, description: q.description, status: q.status }));
}

/** engine log + controller GM lines, oldest first, trimmed */
export function mergedLog(state: GameState, gmLog: LogMessage[]): LogMessage[] {
  if (!gmLog.length) return state.log.slice(-LOG_LIMIT);
  const out: LogMessage[] = [];
  let i = 0;
  let j = 0;
  const a = state.log;
  // stable merge by turn; GM lines go after engine lines of the same turn
  while (i < a.length || j < gmLog.length) {
    if (j >= gmLog.length || (i < a.length && a[i].turn <= gmLog[j].turn)) out.push(a[i++]);
    else out.push(gmLog[j++]);
  }
  return out.slice(-LOG_LIMIT);
}

export interface GameViewExtras {
  gmLog: LogMessage[];
  narration: NarrationView | null;
  mode: GameView['mode'];
  targetingSlot?: number;
  dialogueHistory: { who: 'npc' | 'player'; text: string }[];
  /** dialogue options to leave out of the reply list (the session's dialogueReply uses the same) */
  dialogueSkip?: DialogueSkip;
  tradeOpen: boolean;
  busy?: string | null;
  rules?: RuleTracker;
  interactHint?: string | null;
  /** the usable tile next to the player (context bar "Use …") */
  interact?: { name: string } | null;
  /** the onboarding card to show (null hides it) */
  onboarding?: OnboardingView | null;
  /** engine legalActions(state), when the caller already has them */
  legal?: readonly PlayerAction[];
  /** item thumbnails by def id (renderer), used for known items only */
  thumbs?: (defId: string) => string | undefined;
}

/**
 * Engine log lines in the world's language when it differs from the UI language: an English world
 * in a Norwegian UI reads "Mesa Rattler is put in the dirt.", not "Mesa Rattler er put in the dirt."
 * (world names and verbs are world text). Such lines lose their catalog key, so the log panel shows
 * them as they are (issues/M5-mixed-language-world-ui.md).
 */
export function worldLanguageLog(log: LogMessage[], world: Pick<WorldSpec, 'meta' | 'vocabulary'>): LogMessage[] {
  const lang = worldTextLanguage(world);
  if (!lang) return log;
  const hp = world.vocabulary.stats.hp.name;
  return log.map((m) => {
    if (!m.key || m.kind === 'gm' || m.kind === 'npc') return m;
    const { key: _key, params: _params, ...rest } = m;
    return { ...rest, text: logTextIn(m, lang, hp) };
  });
}

export function gameView(world: WorldSpec, state: GameState, x: GameViewExtras): GameView {
  const sheet = playerSheet(state);
  const plan = world.areas[state.area.index];
  // the engine resolves a pending perk choice before any dialogue/GM choice
  // (doPlayerAction rejects choose_option until then), so the view hides those
  // panels while a level-up is pending; they reappear once a perk is picked
  const levelUp = levelUpView(world, state);
  const trade = !levelUp && x.tradeOpen ? tradeView(world, state) : null;
  const hud = hudView(world, state, sheet);
  const slots = slotViews(world, state, describeInventory(state));
  // a quick-slot item that answers a current danger glows ("press 3")
  for (const d of hud.danger ?? []) {
    // only an item pressing would use now: not cooling down, not out of charges, not otherwise
    // unusable (issues/M5-danger-hint-empty-item.md)
    const i = slots.findIndex((sv, idx) => idx < 8 && !!sv?.restores?.includes(d.id) && readyToUse(sv));
    if (i >= 0) {
      d.slot = i;
      slots[i] = { ...slots[i]!, urgent: true };
    }
  }
  const legal = x.legal ?? (state.status === 'playing' ? legalActions(state) : []);
  for (const i of strongMoveSlots(world, state, slots, legal)) slots[i] = { ...slots[i]!, urgent: true };
  if (x.thumbs) {
    for (let i = 0; i < slots.length; i++) {
      const sv = slots[i];
      if (!sv || sv.knowledge === 'unknown') continue;
      const t = x.thumbs(sv.defId);
      if (t) slots[i] = { ...sv, thumb: t };
    }
  }
  const canTransition = transitionBlocker(state) === null;
  return {
    hud,
    log: worldLanguageLog(mergedLog(state, x.gmLog), world),
    slots,
    narration: x.narration,
    dialogue: trade || levelUp ? null : dialogueView(world, state, x.dialogueHistory, x.dialogueSkip),
    choice: levelUp ? null : choiceView(world, state),
    levelUp,
    trade,
    rules: rulesView(world, state, x.rules),
    quests: questsView(state),
    verbs: { talk: !!world.verbs.talk, sneak: !!world.verbs.sneak, search: !!world.verbs.search, persuade: !!world.verbs.persuade },
    transitionName: plan?.transitionName ?? t('help.takeExit'),
    canTransition,
    goalSummary: world.goal.summary,
    mode: x.mode,
    targetingSlot: x.targetingSlot,
    busy: x.busy ?? null,
    ...objectiveFields(objectiveParts(world, state, canTransition)),
    interactHint: x.interactHint ?? null,
    goal: inWorldLanguage(world, () => goalView(world, state)),
    actions: contextActions(world, state, { legal, interact: x.interact ?? null, canTransition }),
    onboarding: x.onboarding ?? null,
  };
}

/** the loss reason, in the world's language when it differs from the UI's (issues/M5-mixed-language-world-ui.md) */
function endReasonText(world: WorldSpec, key: string, params: Record<string, string | number> | undefined, fallback: string): string {
  const lang = worldTextLanguage(world);
  const tpl = lang ? catalog(lang)?.[key] : undefined;
  if (lang && tpl !== undefined) return formatMessage(tpl, params, lang);
  if (lang) return fallback;
  return tx(key, params, fallback);
}

export function endView(world: WorldSpec, state: GameState, epitaph?: string, run?: { difficulty?: EndView['difficulty']; weirdness?: number }): EndView {
  const won = state.status === 'won';
  return {
    result: won ? 'won' : 'lost',
    worldTitle: world.meta.title,
    text: endingText(world, state),
    reason: state.endReasonKey && state.endReason !== undefined ? endReasonText(world, state.endReasonKey, state.endReasonParams, state.endReason) : state.endReason,
    epitaph,
    playerName: world.player.name,
    stats: {
      turns: state.turn,
      kills: state.stats.kills,
      itemsUsed: state.stats.itemsUsed,
      damageDealt: state.stats.damageDealt,
      damageTaken: state.stats.damageTaken,
      areasCleared: state.stats.areasCleared,
      areaCount: world.areas.length,
      level: leadPlayer(state).level,
    },
    ...(run?.difficulty ? { difficulty: run.difficulty } : {}),
    ...(run?.weirdness !== undefined ? { weirdness: run.weirdness } : {}),
  };
}
