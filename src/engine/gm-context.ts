/**
 * GM context (DESIGN §4.3 "Context"): a compact, JSON-able summary of the run for the live GM's
 * prompt: who the player is and what they carry, where they are, who they can see, what just
 * happened, the rules in force, quests, what the goal still needs, and how much the GM may still
 * do (budget, rule room, difficulty). Kept under a token budget (default ~1.5k tokens).
 *
 * Knowledge is respected: items the player has not identified appear under their per-run
 * appearance ("green flask"), never their real name. Ids (`id` fields) are handles for GM actions
 * (give_item, reveal_item, say, change_faction, remove_rule…) and must never be shown to the
 * player. Every string is world-authored or an id; the summary has no English sentences beyond
 * its field names, so it works for a world in any language (`language`).
 *
 * Pure and read-only: the input state is never changed.
 */
import type { WorldSpec } from '../schema/world';
import type { Difficulty, GmHook } from '../schema/gm';
import { MAX_ACTIVE_RULES, MAX_GM_RULES_PER_AREA } from '../schema/gm';
import type { ActorInstance, GameState, LogMessage } from './types';
import { TOTAL_SLOTS } from './types';
import { type Ctx, actorDef, indexWorld, isPlayer, me, playerActor, statusName } from './ctx';
import { cloneState } from './clone';
import { rngFromState } from './rng';
import { generateArea } from './mapgen/index';
import { displayItemName, equippedKindOf } from './inventory';
import { knowledgeOf } from './knowledge';
import { isVisibleToPlayer } from './effects';
import { viewActor } from './describe';
import { getStat, maxHp, maxMp } from './stats';
import { xpToNext } from './progression';
import { activeRuleEntries, estimateRuleImpact, gmRuleHarm } from './rules';
import { difficultyOf, profileOf } from './difficulty';
import { evalCondition } from './conditions';
import { progressRefs } from './goals';
import { cheb, own } from './util';

export const GM_CONTEXT_VERSION = 1;
/** default token budget of the summary */
export const GM_CONTEXT_MAX_TOKENS = 1500;

/** extra facts about the moment (GmHookDetail-like); only primitive values are kept */
export interface GmContextHook {
  hook: GmHook;
  detail?: Record<string, unknown>;
}

export interface GmContextItem {
  /** item def id (handle for give_item / reveal_item; never shown to the player) */
  id: string;
  /** what the player calls it: the real name, or the appearance while unknown */
  name: string;
  n?: number;
  /** absent = clear */
  known?: 'vague' | 'unknown';
  /** equipped as weapon / armour / trinket */
  eq?: 'weapon' | 'armour' | 'trinket';
}

export interface GmContextActor {
  /** actor instance id (handle for say / change_faction) */
  id: string;
  /** actor def id (handle for spawn) */
  def: string;
  name: string;
  faction: ActorInstance['faction'];
  /** hp as a percentage of max */
  hp: number;
  /** Chebyshev distance from the player */
  dist: number;
  threat: 'trivial' | 'even' | 'dangerous' | 'deadly';
  unique?: true;
  /** NPC role (trader, healer…) */
  npc?: string;
  ally?: true;
  statuses?: string[];
}

export interface GmContextSummary {
  v: number;
  hook?: GmHook;
  detail?: Record<string, string | number | boolean>;
  /** BCP-47 language every player-facing GM text must be written in */
  language: string;
  difficulty: Difficulty;
  turn: number;
  status: GameState['status'];
  world: { title: string; genre: string; tone: string; goal: string };
  player: {
    name: string;
    level: number;
    xp: number;
    xpToNext: number;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    stats: { str: number; dex: number; int: number; ac: number };
    /** "Name(turns)" */
    statuses: string[];
    /** custom resources: "Name value/max" */
    resources: string[];
    currency: number;
    perks: string[];
    sneaking?: true;
    inventory: GmContextItem[];
    /** how many inventory entries were left out (token budget) */
    moreItems?: number;
  };
  area: {
    index: number;
    count: number;
    name: string;
    /** names (or ids) of the regions found so far */
    regions: string[];
    regionsTotal: number;
    /** the way onward cannot be taken yet (locked), or this is the last area */
    exitLocked?: true;
    lastArea?: true;
  };
  gm: {
    /** GM budget left in this area */
    budget: number;
    /** a new rule may still be added in this area (count and cap only; the harm check is separate) */
    canAddRule: boolean;
    rulesActive: number;
    rulesMax: number;
    /** harm (hp per 100 turns) the GM rules may still add at this difficulty */
    ruleHarmLeft: number;
    /** a choice is open (offer_choice/trade would be refused) */
    choiceOpen?: true;
  };
  visible: GmContextActor[];
  moreVisible?: number;
  /** recent log lines, oldest first ("speaker: text" for NPC lines) */
  log: string[];
  rules: { id: string; name: string; source: 'world' | 'gm'; harmful?: true }[];
  quests: { id: string; title: string; status: 'active' | 'done' | 'failed' }[];
  /** what the goal, the locks and the active quests depend on, and where it stands */
  progress: {
    flags?: Record<string, boolean>;
    counters?: Record<string, number>;
    /** actor def id → defeated so far / needed */
    defeats?: Record<string, string>;
    /** item def id → carried */
    items?: Record<string, boolean>;
  };
}

export interface GmContextOptions {
  /** token budget (≈ JSON characters / 4); default GM_CONTEXT_MAX_TOKENS */
  maxTokens?: number;
  /** recent log lines to include before trimming (default 8) */
  logLines?: number;
}

/** rough token count of a JSON-able value (≈ 4 characters per token) */
export function estimateTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v).length / 4);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function hookOf(hook: GmHook | GmContextHook | undefined): GmContextHook | undefined {
  if (!hook) return undefined;
  return typeof hook === 'string' ? { hook } : hook;
}

function cleanDetail(d: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'string') out[k] = clip(v, 80);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function logLine(m: LogMessage): string {
  return clip(m.speaker ? `${m.speaker}: ${m.text}` : m.text, 140);
}

function inventoryOf(ctx: Ctx): GmContextItem[] {
  const out: GmContextItem[] = [];
  const byDef = new Map<string, GmContextItem>();
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const it = me(ctx).slots[slot];
    if (!it) continue;
    const eq = equippedKindOf(ctx, slot);
    const prev = byDef.get(it.defId);
    if (prev && !eq && !prev.eq) {
      prev.n = (prev.n ?? 1) + it.count;
      continue;
    }
    const k = knowledgeOf(ctx, it.defId);
    const item: GmContextItem = { id: it.defId, name: displayItemName(ctx, it.defId) };
    if (it.count > 1) item.n = it.count;
    if (k.level !== 'clear') item.known = k.level;
    if (eq) item.eq = eq;
    if (!eq) byDef.set(it.defId, item);
    out.push(item);
  }
  // equipped first, then the rest in slot order
  return [...out.filter((i) => i.eq), ...out.filter((i) => !i.eq)];
}

function visibleOf(ctx: Ctx): GmContextActor[] {
  const p = playerActor(ctx);
  const out: (GmContextActor & { _d: number })[] = [];
  for (const a of ctx.s.area.actors) {
    if (isPlayer(ctx, a) || a.hp <= 0 || !isVisibleToPlayer(ctx, a)) continue;
    const def = actorDef(ctx, a);
    const view = viewActor(ctx, a);
    const mh = Math.max(1, maxHp(ctx, a));
    const e: GmContextActor & { _d: number } = {
      id: a.id,
      def: a.defId,
      name: view.name,
      faction: a.faction,
      hp: Math.max(0, Math.round((a.hp / mh) * 100)),
      dist: cheb(a.pos, p.pos),
      threat: view.threat,
      _d: cheb(a.pos, p.pos),
    };
    if (def?.unique) e.unique = true;
    if (def?.npc) e.npc = def.npc.role;
    if (a.allyOf) e.ally = true;
    if (a.statuses.length) e.statuses = a.statuses.map((s) => statusName(ctx, s.id));
    out.push(e);
  }
  // nearest first; uniques before others at the same distance
  out.sort((x, y) => x._d - y._d || Number(!!y.unique) - Number(!!x.unique) || x.id.localeCompare(y.id));
  return out.map(({ _d, ...rest }) => rest);
}

function progressOf(ctx: Ctx): GmContextSummary['progress'] {
  const refs = progressRefs(ctx);
  const out: GmContextSummary['progress'] = {};
  if (refs.flags.size) out.flags = Object.fromEntries([...refs.flags].sort().map((f) => [f, own(ctx.s.flags, f) ?? false]));
  if (refs.counters.size) out.counters = Object.fromEntries([...refs.counters].sort().map((c) => [c, own(ctx.s.counters, c) ?? 0]));
  if (refs.defeats.size) out.defeats = Object.fromEntries([...refs.defeats].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => [id, `${own(ctx.s.defeated, id) ?? 0}/${n}`]));
  if (refs.items.size) {
    const held = new Set(me(ctx).slots.filter((x) => !!x).map((x) => x!.defId));
    out.items = Object.fromEntries([...refs.items].sort().map((id) => [id, held.has(id)]));
  }
  return out;
}

function summarize(ctx: Ctx, hook: GmContextHook | undefined, logLines: number): GmContextSummary {
  const s = ctx.s;
  const w = ctx.world;
  const p = playerActor(ctx);
  const ps = me(ctx);
  const plan = w.areas[s.area.index];
  const live = activeRuleEntries(w, s);
  const prof = profileOf(s);
  const regionName = new Map(s.area.map.regions.map((r) => [r.id, r.name]));
  const isLast = s.area.index >= w.areas.length - 1;
  const out: GmContextSummary = {
    v: GM_CONTEXT_VERSION,
    language: w.meta.language ?? 'en',
    difficulty: difficultyOf(s),
    turn: s.turn,
    status: s.status,
    world: { title: w.meta.title, genre: w.meta.genre, tone: clip(w.meta.tone, 120), goal: clip(w.goal.summary, 200) },
    player: {
      name: ps.name,
      level: ps.level,
      xp: ps.xp,
      xpToNext: xpToNext(ctx, ps.level),
      hp: p.hp,
      maxHp: maxHp(ctx, p),
      mp: p.mp,
      maxMp: maxMp(ctx, p),
      stats: { str: getStat(ctx, p, 'str'), dex: getStat(ctx, p, 'dex'), int: getStat(ctx, p, 'int'), ac: getStat(ctx, p, 'ac') },
      statuses: p.statuses.map((st) => `${statusName(ctx, st.id)}(${st.turnsLeft})`),
      resources: (w.resources ?? []).map((r) => `${r.name} ${own(ps.resources, r.id) ?? 0}/${r.max}`),
      currency: s.purse,
      perks: ps.perks.map((id) => ctx.ix.perks.get(id)?.name ?? id),
      inventory: inventoryOf(ctx),
    },
    area: {
      index: s.area.index,
      count: w.areas.length,
      name: plan?.name ?? '',
      regions: s.area.discoveredRegions.map((id) => regionName.get(id) ?? String(id)),
      regionsTotal: s.area.map.regions.length,
    },
    gm: {
      budget: s.area.gmBudget,
      canAddRule: live.length < MAX_ACTIVE_RULES && (s.area.gmRulesAdded ?? 0) < MAX_GM_RULES_PER_AREA,
      rulesActive: live.length,
      rulesMax: MAX_ACTIVE_RULES,
      ruleHarmLeft: Math.max(0, Math.round((prof.ruleHarmTotal - gmRuleHarm(ctx, live)) * 10) / 10),
    },
    visible: visibleOf(ctx),
    log: s.log.slice(-Math.max(0, logLines)).map(logLine),
    rules: live.map((e) => {
      const r: GmContextSummary['rules'][number] = { id: e.rule.id, name: e.rule.name, source: e.source };
      if (estimateRuleImpact(w, e.rule).harmful) r.harmful = true;
      return r;
    }),
    quests: s.quests.map((q) => ({ id: q.id, title: clip(q.title, 80), status: q.status })),
    progress: progressOf(ctx),
  };
  if (ps.sneaking) out.player.sneaking = true;
  if (isLast) out.area.lastArea = true;
  else if (plan?.transitionRequires && !evalCondition(ctx, plan.transitionRequires, { self: p })) out.area.exitLocked = true;
  if (ps.pendingChoice || ps.pendingPerkChoice) out.gm.choiceOpen = true;
  const h = hookOf(hook);
  if (h) {
    out.hook = h.hook;
    const d = cleanDetail(h.detail);
    if (d) out.detail = d;
  }
  return out;
}

/** shrinks the summary until it fits `maxTokens` (least important detail first) */
function fit(sum: GmContextSummary, maxTokens: number): GmContextSummary {
  const over = () => estimateTokens(sum) > maxTokens;
  if (!over()) return sum;
  // 1. older log lines (keep at least 3)
  while (over() && sum.log.length > 3) sum.log.shift();
  // 2. farther visible actors (keep at least 4)
  while (over() && sum.visible.length > 4) {
    sum.visible.pop();
    sum.moreVisible = (sum.moreVisible ?? 0) + 1;
  }
  // 3. finished quests, then the regions list
  if (over()) sum.quests = sum.quests.filter((q) => q.status === 'active');
  while (over() && sum.area.regions.length > 3) sum.area.regions.shift();
  // 4. unequipped inventory entries from the end (keep at least 6)
  while (over() && sum.player.inventory.length > 6) {
    sum.player.inventory.pop();
    sum.player.moreItems = (sum.player.moreItems ?? 0) + 1;
  }
  // 5. last resort: everything trimmed to the bone
  if (over()) {
    sum.log = sum.log.slice(-1).map((l) => clip(l, 60));
    sum.visible = sum.visible.slice(0, 2).map((a) => ({ ...a, statuses: undefined, name: clip(a.name, 30) }));
    sum.player.inventory = sum.player.inventory.slice(0, 3).map((i) => ({ ...i, name: clip(i.name, 30) }));
    sum.area.regions = [];
    sum.player.perks = sum.player.perks.slice(-3);
    sum.world.tone = clip(sum.world.tone, 40);
    sum.world.goal = clip(sum.world.goal, 80);
  }
  // 6. still over (a tiny budget): drop whole sections, least important first
  const drops: (() => void)[] = [
    () => (sum.log = []),
    () => (sum.visible = sum.visible.slice(0, 1)),
    () => (sum.quests = []),
    () => (sum.player.perks = []),
    () => (sum.player.inventory = sum.player.inventory.filter((i) => i.eq)),
    () => (sum.rules = sum.rules.map((r) => ({ ...r, name: clip(r.name, 20) }))),
    () => (sum.progress = {}),
    () => (sum.visible = []),
    () => (sum.player.statuses = sum.player.statuses.slice(0, 2)),
    () => (sum.player.resources = []),
  ];
  for (const d of drops) {
    if (!over()) break;
    d();
  }
  return JSON.parse(JSON.stringify(sum)) as GmContextSummary;
}

/**
 * Builds the GM context summary of `state` (read-only; the state is not changed). `hook` names
 * the moment the GM is consulted for (with optional detail such as a region or actor id).
 */
export function buildGmContext(state: GameState, world: WorldSpec, hook?: GmHook | GmContextHook, opts: GmContextOptions = {}): GmContextSummary {
  const { state: s, cow } = cloneState(state);
  // MP1: the GM sees the run through the lead player (MP4 makes it party-aware)
  const ctx: Ctx = { world, ix: indexWorld(world), s, pid: s.party[0], rng: rngFromState(s.rng), events: [], mapGen: generateArea, depth: 0, cow };
  const sum = summarize(ctx, hookOf(hook), opts.logLines ?? 8);
  return fit(sum, Math.max(200, opts.maxTokens ?? GM_CONTEXT_MAX_TOKENS));
}
