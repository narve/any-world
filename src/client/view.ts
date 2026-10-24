/**
 * Pure builders: GameState + WorldSpec (+ controller-side extras) → the UI view model. No DOM, no
 * renderer, so everything here is unit-tested in node (tests/client/view.test.ts).
 */
import type { WorldSpec, ItemDef, Perk } from '../schema/world';
import type { GameState, ItemView, LogMessage, PendingChoice } from '../engine/types';
import { TOTAL_SLOTS } from '../engine/types';
import {
  describeInventory,
  describeItemDef,
  playerSheet,
  transitionBlocker,
  type PlayerSheet,
} from '../engine/index';
import type {
  ChoiceView,
  DialogueView,
  EndView,
  GameView,
  HudView,
  LevelUpView,
  NarrationView,
  PaletteView,
  QuestView,
  RuleView,
  SlotItemView,
  StatusChipView,
  ThemeView,
  TradeView,
} from './ui/viewmodel';

/** durability every item starts with when the durability rule is on (engine DEFAULT_DURABILITY) */
const MAX_DURABILITY = 40;
const LOG_LIMIT = 120;
const POSITIONAL = new Set(['single', 'ray', 'cone', 'area']);

export function themeOf(world: WorldSpec): ThemeView {
  const palette: PaletteView = { ...world.palette };
  return { palette, vocabulary: world.vocabulary };
}

export function playerOf(state: GameState) {
  const p = state.area.actors.find((a) => a.id === state.player.actorId);
  if (!p) throw new Error('player actor missing');
  return p;
}

function equipSlotOf(def: ItemDef): SlotItemView['equipSlot'] {
  if (def.equipSlot) return def.equipSlot;
  if (def.category === 'weapon' && def.weapon) return 'weapon';
  if (def.category === 'armour') return 'armour';
  return undefined;
}

/** activating this item asks the player for a target tile */
export function needsTarget(def: ItemDef): boolean {
  const u = def.onUse;
  if (!u || def.useMode === 'passive') return false;
  return POSITIONAL.has(u.targeting.shape) && u.targeting.affects !== 'self_only';
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
      return { id: r.id, label: r.name, description: r.description, value: v?.value ?? 0, max: r.max, color: r.color };
    }),
    level: state.player.level,
    xpInLevel: sheet.xp,
    xpForLevel: sheet.xpToNext,
    currency: state.player.currency,
    statuses,
    areaName: plan?.name ?? '',
    areaIndex: state.area.index,
    areaCount: world.areas.length,
    turn: state.turn,
    sneaking: state.player.sneaking,
    speed: sheet.speed >= 115 ? 'fast' : sheet.speed <= 85 ? 'slow' : 'normal',
  };
}

export function slotViews(world: WorldSpec, state: GameState, views: (ItemView | null)[]): (SlotItemView | null)[] {
  const defs = new Map(world.items.map((i) => [i.id, i]));
  const out: (SlotItemView | null)[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const it = state.player.slots[i];
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
      sv.rarity = def.rarity;
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
}

export function dialogueMap(pc: PendingChoice): DialogueMap {
  const m: DialogueMap = { labels: [], engineIndex: [], leaveIndex: null, buy: [] };
  pc.options.forEach((o, i) => {
    if (o.tag === 'buy') m.buy.push(i);
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
): DialogueView | null {
  const pc = state.pendingChoice;
  if (!pc || pc.kind !== 'dialogue') return null;
  const npc = state.area.actors.find((a) => a.id === pc.speakerId);
  const def = npc ? world.actors.find((d) => d.id === npc.defId) : undefined;
  const m = dialogueMap(pc);
  return {
    npcId: pc.speakerId ?? '',
    npcName: def?.name ?? 'Someone',
    npcTitle: def?.npc ? def.npc.role.replace('_', ' ') : undefined,
    portraitColor: def?.model.humanoid?.top ?? def?.model.colors?.primary ?? world.palette.accent,
    reply: pc.prompt,
    options: m.labels,
    pending: false,
    canPersuade: !!world.verbs.persuade && !!npc && !npc.allyOf,
    canTrade: m.buy.length > 0,
    history: history.slice(-6),
  };
}

export function choiceView(world: WorldSpec, state: GameState): ChoiceView | null {
  const pc = state.pendingChoice;
  if (!pc || pc.kind !== 'gm_offer') return null;
  const npc = pc.speakerId ? state.area.actors.find((a) => a.id === pc.speakerId) : undefined;
  const def = npc ? world.actors.find((d) => d.id === npc.defId) : undefined;
  return { prompt: pc.prompt, speaker: def?.name, options: pc.options.map((o) => ({ label: o.label })) };
}

function statLabel(world: WorldSpec, stat: string): string {
  const v = world.vocabulary.stats as Record<string, { name: string }>;
  if (v[stat]) return v[stat].name;
  const r = world.resources.find((x) => x.id === stat);
  if (r) return r.name;
  if (stat === 'speed') return 'Speed';
  if (stat === 'sight') return 'Sight';
  return stat;
}

export function perkLines(world: WorldSpec, perk: Perk): string[] {
  const lines = perk.modifiers.map((m) => `${m.amount >= 0 ? '+' : ''}${m.amount} ${statLabel(world, m.stat)}`);
  for (const id of perk.grantItems) {
    const it = world.items.find((i) => i.id === id);
    if (it) lines.push(`Gain: ${it.name}`);
  }
  return lines;
}

export function levelUpView(world: WorldSpec, state: GameState): LevelUpView | null {
  const ids = state.player.pendingPerkChoice;
  if (!ids || !ids.length) return null;
  const perks = ids
    .map((id) => world.player.growth.perks.find((p) => p.id === id))
    .filter((p): p is Perk => !!p)
    .map((p) => ({ id: p.id, name: p.name, description: p.description, lines: perkLines(world, p) }));
  return { level: state.player.level, perks };
}

export function tradeView(world: WorldSpec, state: GameState): TradeView | null {
  const pc = state.pendingChoice;
  if (!pc || pc.kind !== 'dialogue') return null;
  const m = dialogueMap(pc);
  if (!m.buy.length) return null;
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
    traderName: def?.name ?? 'Trader',
    traderColor: def?.model.humanoid?.top ?? def?.model.colors?.primary ?? world.palette.accent,
    greeting: pc.prompt,
    currency: state.player.currency,
    offers,
    sellable: [],
  };
}

function fallbackItemView(label: string): ItemView {
  return { name: label, kind: '', description: '', knowledge: 'clear', effectLines: [], notes: [], count: 1, equipped: false, usable: false, color: '#888888' };
}

export function rulesView(world: WorldSpec): RuleView[] {
  return world.rules.map((r) => ({ id: r.id, name: r.name, description: r.description, since: 'from the start' }));
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
  tradeOpen: boolean;
  busy?: string | null;
}

export function gameView(world: WorldSpec, state: GameState, x: GameViewExtras): GameView {
  const sheet = playerSheet(state);
  const plan = world.areas[state.area.index];
  // the engine resolves a pending perk choice before any dialogue/GM choice
  // (doPlayerAction rejects choose_option until then), so the view hides those
  // panels while a level-up is pending; they reappear once a perk is picked
  const levelUp = levelUpView(world, state);
  const trade = !levelUp && x.tradeOpen ? tradeView(world, state) : null;
  return {
    hud: hudView(world, state, sheet),
    log: mergedLog(state, x.gmLog),
    slots: slotViews(world, state, describeInventory(state)),
    narration: x.narration,
    dialogue: trade || levelUp ? null : dialogueView(world, state, x.dialogueHistory),
    choice: levelUp ? null : choiceView(world, state),
    levelUp,
    trade,
    rules: rulesView(world),
    quests: questsView(state),
    verbs: { talk: !!world.verbs.talk, sneak: !!world.verbs.sneak, search: !!world.verbs.search, persuade: !!world.verbs.persuade },
    transitionName: plan?.transitionName ?? 'Move on',
    canTransition: transitionBlocker(state) === null,
    goalSummary: world.goal.summary,
    mode: x.mode,
    targetingSlot: x.targetingSlot,
    busy: x.busy ?? null,
  };
}

export function endView(world: WorldSpec, state: GameState, epitaph?: string): EndView {
  const won = state.status === 'won';
  return {
    result: won ? 'won' : 'lost',
    worldTitle: world.meta.title,
    text: won ? world.goal.winText : world.goal.lossText,
    reason: state.endReason,
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
      level: state.player.level,
    },
  };
}
