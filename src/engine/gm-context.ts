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
 * Parties (MP4 design §2.1): `player` is the player the moment is about (the lead of the state
 * handed in: the room passes perspective(state, pid)); a party of 2+ adds the other members on the
 * map (`party`, nearest first), `visible` lists what any member sees, and `progress.items` looks in
 * every pack. A party of one gets exactly the summary it got before. Rooms may add the players'
 * chat (`chat`, already cleaned and clipped), which counts against the same token budget and is the
 * first thing `fit` trims; the prompt layer takes it out of the JSON and quotes it on its own.
 *
 * Pure and read-only: the input state is never changed.
 */
import type { WorldSpec } from '../schema/world';
import type { Difficulty, GmHook } from '../schema/gm';
import { MAX_ACTIVE_RULES, MAX_GM_RULES_PER_AREA } from '../schema/gm';
import type { ActorInstance, GameState, LogMessage, PlayerId } from './types';
import { TOTAL_SLOTS } from './types';
import { type Ctx, actorDef, indexWorld, isPlayer, me, playerActor, playerActorOf, statusName } from './ctx';
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
/** extra tokens per party member beyond the first, and the cap (MP4 design §2.1) */
export const GM_CONTEXT_TOKENS_PER_MEMBER = 120;
export const GM_CONTEXT_MAX_PARTY_TOKENS = 2600;
/** party members listed in full (nearest first); the rest are counted in moreParty */
export const GM_CONTEXT_PARTY_LIST = 8;
/** item names listed per party member */
const PARTY_ITEMS = 4;

/** the default token budget for a party of `n` on the map (n = 1: GM_CONTEXT_MAX_TOKENS) */
export function gmContextTokens(n: number): number {
  return Math.min(GM_CONTEXT_MAX_PARTY_TOKENS, GM_CONTEXT_MAX_TOKENS + GM_CONTEXT_TOKENS_PER_MEMBER * Math.max(0, Math.floor(n) - 1));
}

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

/** another party member on the map, as the GM sees them (parties of 2+ only) */
export interface GmContextMember {
  /** player id (the handle for a room answer's "player" field) */
  id: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  /** "Name(turns)" */
  statuses: string[];
  /** down: fell with no second chance left (gets up when a teammate stands by) */
  down?: true;
  /** the seat is disconnected */
  away?: true;
  /** typing, in a menu, or in a dialogue or trade */
  busy?: true;
  /** a choice is open for them (an offer_choice or trade for them would be refused) */
  choiceOpen?: true;
  /** Chebyshev distance from the player the moment is about */
  dist: number;
  /** up to 4 item names as that member knows them (equipped first) */
  items: string[];
  moreItems?: number;
}

/** one chat line as the GM context carries it (rooms only; cleaned and clipped by the caller) */
export interface GmContextChatLine {
  from: string;
  said: string;
  /** seconds since it was said */
  ageS: number;
  /** said after the GM last answered the chat */
  new?: true;
}

/** a recent log line with its source (rooms: quoted as data, MP4 design §2.3) */
export interface GmContextLogLine {
  t: number;
  by: 'gm' | 'npc' | 'world' | 'player';
  /** the speaker, for npc and player lines */
  who?: string;
  text: string;
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
    /** player id (parties of 2+ only) */
    id?: string;
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
  /** the other party members on the map, nearest first (parties of 2+ only) */
  party?: GmContextMember[];
  /** members on the map left out of `party` (token budget, or beyond the nearest 8) */
  moreParty?: number;
  visible: GmContextActor[];
  moreVisible?: number;
  /** recent log lines, oldest first ("speaker: text" for NPC lines; objects with a source when quoted) */
  log: (string | GmContextLogLine)[];
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
  /** the players' chat, oldest first (rooms only; the prompt quotes it outside the JSON) */
  chat?: GmContextChatLine[];
}

export interface GmContextOptions {
  /** token budget (≈ JSON characters / 4); default GM_CONTEXT_MAX_TOKENS */
  maxTokens?: number;
  /** recent log lines to include before trimming (default 8) */
  logLines?: number;
  /** log lines as objects with their source (GmContextLogLine), for prompts that quote them as data */
  quoteLog?: boolean;
  /** the players' chat (rooms), oldest first: trimmed first when over budget */
  chat?: readonly GmContextChatLine[];
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

/** a log line with its source mark: gm and npc lines by kind, a party member's words as player */
function quotedLogLine(m: LogMessage, names: ReadonlySet<string>): GmContextLogLine {
  const by: GmContextLogLine['by'] = m.kind === 'gm' ? 'gm' : m.kind === 'npc' ? 'npc' : m.speaker && names.has(m.speaker) ? 'player' : m.speaker ? 'npc' : 'world';
  const out: GmContextLogLine = { t: m.turn, by, text: clip(m.text, 140) };
  if (m.speaker) out.who = clip(m.speaker, 40);
  return out;
}

const clipLogLine = (l: string | GmContextLogLine, n: number): string | GmContextLogLine => (typeof l === 'string' ? clip(l, n) : { ...l, text: clip(l.text, n) });

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

/** the party's other members on the map (not the player the moment is about), in party order */
function othersOnMap(ctx: Ctx): PlayerId[] {
  return ctx.s.party.filter((id) => id !== ctx.pid && !!playerActorOf(ctx, id));
}

/**
 * Actors the player sees now; in a party, actors any standing member sees (each by their own fog),
 * with `dist` to the nearest member who sees them.
 */
function visibleOf(ctx: Ctx, others: readonly PlayerId[]): GmContextActor[] {
  const p = playerActor(ctx);
  const viewers = others.filter((id) => !ctx.s.players[id]!.down).map((id) => ({ ctx: { ...ctx, pid: id }, pos: playerActorOf(ctx, id)!.pos }));
  const out: (GmContextActor & { _d: number })[] = [];
  for (const a of ctx.s.area.actors) {
    if (isPlayer(ctx, a) || a.hp <= 0) continue;
    let d = isVisibleToPlayer(ctx, a) ? cheb(a.pos, p.pos) : Infinity;
    for (const v of viewers) if (isVisibleToPlayer(v.ctx, a)) d = Math.min(d, cheb(a.pos, v.pos));
    if (d === Infinity) continue;
    const def = actorDef(ctx, a);
    const view = viewActor(ctx, a);
    const mh = Math.max(1, maxHp(ctx, a));
    const e: GmContextActor & { _d: number } = {
      id: a.id,
      def: a.defId,
      name: view.name,
      faction: a.faction,
      hp: Math.max(0, Math.round((a.hp / mh) * 100)),
      dist: d,
      threat: view.threat,
      _d: d,
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

/** the other members on the map, nearest first (ties in party order), the nearest 8 kept */
function partyOf(ctx: Ctx, others: readonly PlayerId[]): { list: GmContextMember[]; more: number } {
  const p = playerActor(ctx);
  const all = others.map((id, i) => {
    const ps = ctx.s.players[id]!;
    const a = playerActorOf(ctx, id)!;
    const mctx: Ctx = { ...ctx, pid: id };
    const inv = inventoryOf(mctx);
    const m: GmContextMember = {
      id,
      name: clip(ps.name, 40),
      level: ps.level,
      hp: a.hp,
      maxHp: maxHp(mctx, a),
      statuses: a.statuses.map((st) => `${statusName(ctx, st.id)}(${st.turnsLeft})`),
      dist: cheb(a.pos, p.pos),
      items: inv.slice(0, PARTY_ITEMS).map((x) => (x.n ? `${x.name} x${x.n}` : x.name)),
    };
    if (inv.length > PARTY_ITEMS) m.moreItems = inv.length - PARTY_ITEMS;
    if (ps.down) m.down = true;
    if (ps.away) m.away = true;
    if (ps.busySince !== null && ps.busySince !== undefined) m.busy = true;
    if (ps.pendingChoice || ps.pendingPerkChoice) m.choiceOpen = true;
    return { m, i };
  });
  all.sort((x, y) => x.m.dist - y.m.dist || x.i - y.i);
  return { list: all.slice(0, GM_CONTEXT_PARTY_LIST).map((x) => x.m), more: Math.max(0, all.length - GM_CONTEXT_PARTY_LIST) };
}

/** `party` (and `moreParty`) for a party of 2+ on the map; nothing for a party of one */
function partyBlock(ctx: Ctx, others: readonly PlayerId[]): Pick<GmContextSummary, 'party' | 'moreParty'> {
  if (!others.length) return {};
  const { list, more } = partyOf(ctx, others);
  return more ? { party: list, moreParty: more } : { party: list };
}

function progressOf(ctx: Ctx): GmContextSummary['progress'] {
  const refs = progressRefs(ctx);
  const out: GmContextSummary['progress'] = {};
  if (refs.flags.size) out.flags = Object.fromEntries([...refs.flags].sort().map((f) => [f, own(ctx.s.flags, f) ?? false]));
  if (refs.counters.size) out.counters = Object.fromEntries([...refs.counters].sort().map((c) => [c, own(ctx.s.counters, c) ?? 0]));
  if (refs.defeats.size) out.defeats = Object.fromEntries([...refs.defeats].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => [id, `${own(ctx.s.defeated, id) ?? 0}/${n}`]));
  if (refs.items.size) {
    // any member's pack (a party shares the goal: whoever carries the item carries it for all)
    const held = new Set(Object.values(ctx.s.players).flatMap((ps) => ps.slots.filter((x) => !!x).map((x) => x!.defId)));
    out.items = Object.fromEntries([...refs.items].sort().map((id) => [id, held.has(id)]));
  }
  return out;
}

function summarize(ctx: Ctx, hook: GmContextHook | undefined, opts: GmContextOptions): GmContextSummary {
  const s = ctx.s;
  const logLines = opts.logLines ?? 8;
  const others = othersOnMap(ctx);
  const names = new Set(Object.values(s.players).map((x) => x.name));
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
      ...(others.length ? { id: ctx.pid } : {}),
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
    ...partyBlock(ctx, others),
    visible: visibleOf(ctx, others),
    log: s.log.slice(-Math.max(0, logLines)).map((m) => (opts.quoteLog ? quotedLogLine(m, names) : logLine(m))),
    rules: live.map((e) => {
      const r: GmContextSummary['rules'][number] = { id: e.rule.id, name: e.rule.name, source: e.source };
      if (estimateRuleImpact(w, e.rule).harmful) r.harmful = true;
      return r;
    }),
    quests: s.quests.map((q) => ({ id: q.id, title: clip(q.title, 80), status: q.status })),
    progress: progressOf(ctx),
  };
  if (opts.chat?.length) out.chat = opts.chat.map((c) => ({ ...c }));
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
  // 0. a party's extras (MP4 design §2.1): older chat lines (keep 2), members' items and statuses,
  // members beyond the nearest 4
  if (sum.chat) while (over() && sum.chat.length > 2) sum.chat.shift();
  if (sum.party) {
    for (const m of sum.party) {
      if (!over()) break;
      if (m.items.length) m.moreItems = (m.moreItems ?? 0) + m.items.length;
      m.items = [];
    }
    for (const m of sum.party) {
      if (!over()) break;
      m.statuses = [];
    }
    while (over() && sum.party.length > 4) {
      sum.party.pop();
      sum.moreParty = (sum.moreParty ?? 0) + 1;
    }
  }
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
    sum.log = sum.log.slice(-1).map((l) => clipLogLine(l, 60));
    sum.visible = sum.visible.slice(0, 2).map((a) => ({ ...a, statuses: undefined, name: clip(a.name, 30) }));
    sum.player.inventory = sum.player.inventory.slice(0, 3).map((i) => ({ ...i, name: clip(i.name, 30) }));
    sum.area.regions = [];
    sum.player.perks = sum.player.perks.slice(-3);
    sum.world.tone = clip(sum.world.tone, 40);
    sum.world.goal = clip(sum.world.goal, 80);
  }
  // 6. still over (a tiny budget): drop whole sections, least important first
  const drops: (() => void)[] = [
    () => sum.chat && (sum.chat = sum.chat.slice(-1).map((c) => ({ ...c, said: clip(c.said, 60) }))),
    () => (sum.log = []),
    () => (sum.visible = sum.visible.slice(0, 1)),
    () => (sum.quests = []),
    () => (sum.player.perks = []),
    () => (sum.player.inventory = sum.player.inventory.filter((i) => i.eq)),
    () => (sum.rules = sum.rules.map((r) => ({ ...r, name: clip(r.name, 20) }))),
    () => (sum.progress = {}),
    () => (sum.visible = []),
    () => sum.party && ((sum.moreParty = (sum.moreParty ?? 0) + sum.party.length - 1), (sum.party = sum.party.slice(0, 1))),
    () => (sum.chat = undefined),
    () => sum.party && ((sum.moreParty = (sum.moreParty ?? 0) + sum.party.length), (sum.party = [])),
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
  // the run through the lead player: the moment's player (a room passes perspective(state, pid))
  const ctx: Ctx = { world, ix: indexWorld(world), s, pid: s.party[0], rng: rngFromState(s.rng), events: [], mapGen: generateArea, depth: 0, cow };
  const sum = summarize(ctx, hookOf(hook), opts);
  return fit(sum, Math.max(200, opts.maxTokens ?? gmContextTokens(s.party.length)));
}
