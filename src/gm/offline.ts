/**
 * The offline game master and GM-moment detection, shared by the client and the room server
 * (docs/progress/MP2-DESIGN.md §6). Moved here from src/client/gm-director.ts, which keeps the
 * async GmRunner and re-exports these names. No DOM and no client code: labels come through an
 * injected `t`.
 *
 *  - `GmDirector` is the pluggable brain: `respond(request) → Promise<GmResponse | null>`. The
 *    OFFLINE director below answers from the world's canned lines (gm.fallback, NPC lines) and the
 *    area's actor/item pools; the M3 LLM director (llm/gm-runtime) implements the same interface.
 *  - `gmHooksFor` decides which GM moments (GmHook) a turn produced. It prefers the engine's own
 *    hook queue when the engine exposes one (state.gmQueue / engine gmHooksFor) and otherwise
 *    derives the hooks from the step's events.
 */
import type { WorldSpec, ItemDef } from '../schema/world';
import type { Difficulty, GmAction, GmHook, GmResponse } from '../schema/gm';
import { GM_ACTION_COST } from '../schema/gm';
import type { GameEvent, GameState, LogMessage, PlayerId, Pos } from '../engine/types';
import type { GmContextChatLine } from '../engine/gm-context';
import * as engine from '../engine/index';
import { leadPlayer } from '../engine/index';

export type { Difficulty };

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** extra facts about the moment (all optional; hooks fill what they know) */
export interface GmHookDetail {
  regionId?: number;
  regionName?: string;
  /** actor instance id (boss seen, NPC nearby, unique defeated…) */
  actorId?: string;
  questId?: string;
  level?: number;
  reason?: string;
  /** the player the moment is about (parties of 2+ only: low_hp, boss_seen, area_enter, milestone) */
  playerId?: PlayerId;
}

/** one GM moment, as queued for the director */
export interface GmHookEvent {
  hook: GmHook;
  /** area index the hook belongs to (results for another area are stale) */
  area: number;
  turn: number;
  detail?: GmHookDetail;
}

/** everything a director may look at; a snapshot, never mutated by the director */
export interface GmContext {
  world: WorldSpec;
  /** engine state when the hook fired (read-only snapshot) */
  state: GameState;
  difficulty: Difficulty;
  /** 0 (familiar) .. 1 (unhinged) */
  weirdness: number;
  /** last few log lines, oldest first (for an LLM prompt) */
  recentLog: LogMessage[];
  /** turn the player entered the current area */
  areaEnteredTurn: number;
  /** rooms: the players' recent chat (src/gm/chat.ts chatQuotes), quoted in the prompt as untrusted data */
  chat?: GmContextChatLine[];
}

export interface GmRequest extends GmHookEvent {
  /** unique per runner */
  id: number;
  ctx: GmContext;
  /** aborted on area change, run end, timeout or dispose; a director should stop work */
  signal: AbortSignal;
}

/**
 * The GM brain. `respond` may take as long as it likes (the runner times it out); it resolves
 * null when it has nothing to add. It must not mutate `req.ctx`.
 */
export interface GmDirector {
  readonly name: string;
  respond(req: GmRequest): Promise<GmResponse | null>;
}

// ---------------------------------------------------------------------------
// Deterministic helpers (the offline GM never uses Math.random: same seed, same run)
// ---------------------------------------------------------------------------

/** small string/number hash (FNV-1a) */
export function hashOf(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x7c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pickBy<T>(list: readonly T[], h: number): T | undefined {
  return list.length ? list[h % list.length] : undefined;
}

function weightedPick<T extends { weight?: number }>(list: readonly T[], h: number): T | undefined {
  const total = list.reduce((n, x) => n + Math.max(0, x.weight ?? 10), 0);
  if (total <= 0) return pickBy(list, h);
  let r = (h % 10007) / 10007 * total;
  for (const x of list) {
    r -= Math.max(0, x.weight ?? 10);
    if (r < 0) return x;
  }
  return list[list.length - 1];
}

/** flag the offline GM sets when it has run an area's event (persists in saves) */
export function eventFlag(area: number): string {
  return `gm_event_area_${area}`;
}

/** flag set when an NPC's canned line has been spoken by the GM */
export function saidFlag(actorId: string): string {
  return `gm_said_${actorId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
}

/** total budget cost of a response (offer_choice reserves its costliest option, as the engine does) */
export function responseCost(actions: readonly GmAction[]): number {
  let n = 0;
  for (const a of actions) {
    n += actionCost(a.type);
    if (a.type === 'offer_choice' && Array.isArray(a.options)) n += Math.max(0, ...a.options.map((o) => (Array.isArray(o.actions) ? o.actions : []).reduce((m, x) => m + actionCost(x.type), 0)));
  }
  return n;
}

/** whether `type` is a known GM action type (own keys only: 'constructor' etc. are not actions) */
export function isGmActionType(type: unknown): type is GmAction['type'] {
  return typeof type === 'string' && Object.hasOwn(GM_ACTION_COST, type);
}

/** budget cost of one action type; unknown or inherited keys cost 0 */
function actionCost(type: unknown): number {
  if (!isGmActionType(type)) return 0;
  const c = GM_ACTION_COST[type];
  return Number.isFinite(c) ? c : 0;
}

// ---------------------------------------------------------------------------
// Offline director
// ---------------------------------------------------------------------------

/** the message keys the offline director labels its offers with (en.ts / nb.ts) */
export type OfflineGmKey = 'gm.offer.take' | 'gm.offer.leave';

/** a translation lookup: the client passes its i18n `t`, the server one for the world's language */
export type GmTranslate = (key: OfflineGmKey, params?: Record<string, string | number>) => string;

/** English labels, for callers without a catalog */
const ENGLISH: Record<OfflineGmKey, string> = { 'gm.offer.take': 'Take the {item}', 'gm.offer.leave': 'Leave it be' };

const englishT: GmTranslate = (key, params) => ENGLISH[key].replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));

export interface OfflineDirectorOptions {
  /** minimum turns spent in an area before its event may fire (default 6) */
  eventDelay?: number;
  /** labels of the offer options (default: English) */
  t?: GmTranslate;
}

function player(state: GameState) {
  return state.area.actors.find((a) => a.id === leadPlayer(state).actorId);
}

function seenNow(state: GameState, p: Pos, pid: PlayerId = state.party[0]): boolean {
  const seen = state.players[pid]?.seen as ArrayLike<number> | undefined;
  return (seen?.[p.y * state.area.map.width + p.x] ?? 0) === 2;
}

/**
 * GM from canned material only. Presence is moderate (DESIGN §4.3): the intro and every area
 * arrival get their fallback line, NPCs nearby may speak one canned line when a new region opens,
 * and each area gets exactly one budgeted event (gm.fallback.events + a safe action from the
 * area's pools). Low-HP lines are already spoken by the engine, so that hook stays silent.
 */
export class OfflineGmDirector implements GmDirector {
  readonly name = 'offline';
  private eventDelay: number;
  private t: GmTranslate;

  constructor(opts: OfflineDirectorOptions = {}) {
    this.eventDelay = opts.eventDelay ?? 6;
    this.t = opts.t ?? englishT;
  }

  async respond(req: GmRequest): Promise<GmResponse | null> {
    return this.respondSync(req);
  }

  /** the same answer, synchronously (tests, and the controller's no-wait path) */
  respondSync(req: Pick<GmRequest, 'hook' | 'area' | 'turn' | 'detail' | 'ctx'>): GmResponse | null {
    const { world, state } = req.ctx;
    const fb = world.gm.fallback;
    switch (req.hook) {
      case 'intro':
        return fb.intro ? { actions: [{ type: 'narrate', text: fb.intro }] } : null;
      case 'area_enter': {
        const line = fb.areaEnter[req.area] ?? pickBy(fb.areaEnter, hashOf(state.seed, req.area));
        return line ? { actions: [{ type: 'narrate', text: line }] } : null;
      }
      case 'region_discovered':
      case 'idle':
      case 'milestone':
      case 'boss_seen': {
        const ev = this.event(req);
        if (ev) return ev;
        if (req.hook === 'region_discovered') return this.npcLine(req);
        return null;
      }
      default:
        // low_hp (the engine speaks), death / victory (the end screen), chat (rooms' AI GM only)
        return null;
    }
  }

  /** one NPC in view (not yet heard from) says one of its canned lines */
  private npcLine(req: Pick<GmRequest, 'ctx' | 'area'>): GmResponse | null {
    const { world, state } = req.ctx;
    const pl = player(state);
    if (!pl) return null;
    const defs = new Map(world.actors.map((d) => [d.id, d]));
    const cands = state.area.actors
      .filter((a) => a.hp > 0 && a.id !== pl.id && a.faction !== 'hostile' && seenNow(state, a.pos))
      .filter((a) => (defs.get(a.defId)?.npc?.lines.length ?? 0) > 0 && !state.flags[saidFlag(a.id)])
      .sort((a, b) => Math.max(Math.abs(a.pos.x - pl.pos.x), Math.abs(a.pos.y - pl.pos.y)) - Math.max(Math.abs(b.pos.x - pl.pos.x), Math.abs(b.pos.y - pl.pos.y)) || a.id.localeCompare(b.id));
    const npc = cands[0];
    if (!npc) return null;
    const lines = defs.get(npc.defId)!.npc!.lines;
    const text = pickBy(lines, hashOf(state.seed, npc.id, state.turn))!;
    return { actions: [{ type: 'say', actorId: npc.id, text }, { type: 'set_flag', flag: saidFlag(npc.id), value: true }] };
  }

  /** the area's one event: narration + one safe, budgeted action */
  private event(req: Pick<GmRequest, 'ctx' | 'area' | 'turn'>): GmResponse | null {
    const { world, state, difficulty } = req.ctx;
    const area = state.area.index;
    if (area !== req.area || state.status !== 'playing') return null;
    if (state.flags[eventFlag(area)]) return null;
    if (leadPlayer(state).pendingChoice || leadPlayer(state).pendingPerkChoice) return null;
    const since = req.turn - req.ctx.areaEnteredTurn;
    if (since < this.eventDelay) return null;
    const plan = world.areas[area];
    if (!plan) return null;
    const pl = player(state);
    if (!pl) return null;
    const h = hashOf(state.seed, 'event', area);
    const line = pickBy(world.gm.fallback.events, h) ?? plan.gmNotes ?? '';
    const budget = state.area.gmBudget;
    const items = new Map(world.items.map((i) => [i.id, i]));
    const pool = plan.items.filter((x) => items.has(x.item) && (x.weight ?? 10) > 0);
    const helpful = pool.filter((x) => !isHarmful(world, items.get(x.item)!));
    const hostiles = plan.actors.filter((x) => {
      const d = world.actors.find((a) => a.id === x.actor);
      return d && !d.npc && !d.unique && (x.weight ?? 10) > 0;
    });
    const hpFrac = pl.maxHp > 0 ? pl.hp / pl.maxHp : 1;

    // candidate events, cheapest-safe first when health is low or the player asked for gentle
    const kinds: ('gift' | 'offer' | 'spawn')[] = [];
    const roll = h % 3;
    if (roll === 0) kinds.push('offer', 'gift', 'spawn');
    else if (roll === 1) kinds.push('gift', 'offer', 'spawn');
    else kinds.push('spawn', 'gift', 'offer');
    const flag: GmAction = { type: 'set_flag', flag: eventFlag(area), value: true };
    const narrate: GmAction[] = line ? [{ type: 'narrate', text: line }] : [];

    for (const kind of kinds) {
      if (kind === 'spawn') {
        if (difficulty === 'gentle' || hpFrac < 0.6 || !hostiles.length) continue;
        const pick = weightedPick(hostiles, h >>> 3)!;
        const acts: GmAction[] = [...narrate, { type: 'spawn', actor: pick.actor, count: 1, near: 'random' }, flag];
        if (responseCost(acts) <= budget) return { actions: acts };
      } else if (kind === 'gift') {
        const pick = weightedPick(helpful.length ? helpful : pool, h >>> 5);
        if (!pick) continue;
        const acts: GmAction[] = [...narrate, { type: 'place_item', item: pick.item, near: 'player' }, flag];
        if (responseCost(acts) <= budget) return { actions: acts };
      } else {
        const pick = weightedPick(helpful.length ? helpful : pool, h >>> 7);
        if (!pick) continue;
        const name = displayName(state, items.get(pick.item)!);
        const acts: GmAction[] = [
          flag,
          {
            type: 'offer_choice',
            prompt: line || `${name}?`,
            options: [
              { label: this.t('gm.offer.take', { item: name }), actions: [{ type: 'give_item', item: pick.item, count: 1 }] },
              { label: this.t('gm.offer.leave'), actions: [{ type: 'grant_xp', amount: 5 + area * 5 }] },
            ],
          },
        ];
        if (responseCost(acts) <= budget) return { actions: acts };
      }
    }
    // nothing affordable: still tell the story, and mark the area as done
    return narrate.length ? { actions: [...narrate, flag] } : null;
  }
}

/** an item whose use hurts its user (never handed out as a "gift") */
function isHarmful(world: WorldSpec, def: ItemDef): boolean {
  const u = def.onUse;
  if (!u || !(u.targeting.affects === 'self_only' || u.targeting.shape === 'self')) return false;
  const harmfulStatus = new Set(world.statuses.filter((s) => s.harmful).map((s) => s.id));
  return u.effects.some((e) => e.type === 'damage' || (e.type === 'apply_status' && harmfulStatus.has(e.status)));
}

/** knowledge-aware item name (unknown items show their appearance, never their identity) */
function displayName(state: GameState, def: ItemDef): string {
  const k = leadPlayer(state).knowledge[def.id];
  if (k && k.level === 'unknown' && k.appearance) return k.appearance.label;
  return def.name;
}

// ---------------------------------------------------------------------------
// Hook detection
// ---------------------------------------------------------------------------

/** controller-side memory for hook derivation (persisted with the run) */
export interface HookTracker {
  /** turn of the last hook that went to the director */
  lastHookTurn: number;
  /** turn the current area was entered */
  areaEnteredTurn: number;
  /** unique/boss actor instance ids already announced */
  bossesSeen: string[];
  /**
   * Party throttles (parties of 2+ only, MP4 design §2.2; absent in single player's saves): the area
   * each player last had a low_hp hook in, and the turns of the party's last low_hp and
   * region_discovered hooks. Turn-based, so a replay rebuilds the same tracker.
   */
  lowHpAt?: Record<PlayerId, number>;
  lastLowHpTurn?: number;
  lastRegionTurn?: number;
  /**
   * Rooms only (MP4 design §1.5): the helpful GM actions of the current area, counted from the gm
   * entries (on the state before each), so the help ceiling survives a restart. Absent in single player.
   */
  help?: { area: number; used: number };
}

export function newHookTracker(turn = 0): HookTracker {
  return { lastHookTurn: turn, areaEnteredTurn: turn, bossesSeen: [] };
}

/** a deep copy (stored snapshots never share nested objects with the live tracker) */
export function cloneTracker(t: HookTracker): HookTracker {
  return structuredClone(t);
}

/** party hooks: at most one low_hp hook per player per area, and one per this many turns for the party */
export const PARTY_LOW_HP_TURNS = 12;
/** party hooks: at most one region_discovered hook per this many turns */
export const PARTY_REGION_TURNS = 10;

/** turns without any hook before an 'idle' hook (DESIGN §4.3 "occasionally on a timer") */
export const IDLE_TURNS = 60;
/** the first idle hook of an area comes sooner, so every area gets its event */
export const FIRST_IDLE_TURNS = 18;

type EngineHookApi = { gmHooksFor?: (state: GameState, events: GameEvent[]) => unknown };

function asHook(x: unknown, state: GameState): GmHookEvent | null {
  const parsed = typeof x === 'string' ? { hook: x } : (x as { hook?: unknown; type?: unknown; area?: unknown; turn?: unknown; detail?: unknown } | null);
  if (!parsed || typeof parsed !== 'object') return null;
  const hook = (parsed.hook ?? parsed.type) as GmHook;
  const valid: readonly string[] = ['intro', 'area_enter', 'region_discovered', 'low_hp', 'boss_seen', 'milestone', 'idle', 'death', 'victory'];
  if (!valid.includes(hook as string)) return null;
  return {
    hook,
    area: typeof parsed.area === 'number' ? parsed.area : state.area.index,
    turn: typeof parsed.turn === 'number' ? parsed.turn : state.turn,
    ...(parsed.detail && typeof parsed.detail === 'object' ? { detail: parsed.detail as GmHookDetail } : {}),
  };
}

/** hooks queued by the engine itself (state.gmQueue), when this engine version has them */
export function engineQueuedHooks(state: GameState): GmHookEvent[] | null {
  const q = (state as GameState & { gmQueue?: unknown }).gmQueue;
  if (!Array.isArray(q)) return null;
  return q.map((x) => asHook(x, state)).filter((x): x is GmHookEvent => !!x);
}

/** a copy of the state with the engine's hook queue drained (the same object if there is none) */
export function drainEngineQueue(state: GameState): GameState {
  const q = (state as GameState & { gmQueue?: unknown }).gmQueue;
  if (!Array.isArray(q) || q.length === 0) return state;
  return { ...state, gmQueue: [] } as GameState;
}

/**
 * The GM moments produced by one engine step (`before` → `after` with `events`). Uses the engine's
 * queue or gmHooksFor when available; otherwise derives the hooks from the events. Updates the
 * tracker (idle timer, area entry, bosses seen).
 */
export function gmHooksFor(world: WorldSpec, before: GameState, after: GameState, events: GameEvent[], tracker: HookTracker): GmHookEvent[] {
  let out: GmHookEvent[] | null = engineQueuedHooks(after);
  if (out === null) {
    const api = engine as unknown as EngineHookApi;
    if (typeof api.gmHooksFor === 'function') {
      try {
        const r = api.gmHooksFor(after, events);
        if (Array.isArray(r)) out = r.map((x) => asHook(x, after)).filter((x): x is GmHookEvent => !!x);
      } catch {
        out = null;
      }
    }
  }
  if (out === null) out = deriveHooks(world, before, after, events, tracker);
  // area change resets the idle clock; any hook counts as GM attention
  if (after.area.index !== before.area.index) tracker.areaEnteredTurn = after.turn;
  if (out.length) tracker.lastHookTurn = after.turn;
  else if (after.status === 'playing') {
    const sinceArea = after.turn - tracker.areaEnteredTurn;
    const sinceHook = after.turn - tracker.lastHookTurn;
    const firstIdle = !after.flags[eventFlag(after.area.index)] && sinceArea >= FIRST_IDLE_TURNS && sinceHook >= FIRST_IDLE_TURNS;
    if (firstIdle || sinceHook >= IDLE_TURNS) {
      out.push({ hook: 'idle', area: after.area.index, turn: after.turn });
      tracker.lastHookTurn = after.turn;
    }
  }
  return out;
}

/** a party of 2+ (anyone ever joined): the party rules of deriveHooks apply */
function isParty(state: GameState): boolean {
  return Object.keys(state.players).length > 1;
}

function deriveHooks(world: WorldSpec, before: GameState, after: GameState, events: GameEvent[], tracker: HookTracker): GmHookEvent[] {
  if (isParty(after)) return derivePartyHooks(world, before, after, events, tracker);
  const out: GmHookEvent[] = [];
  const area = after.area.index;
  const turn = after.turn;
  const push = (hook: GmHook, detail?: GmHookDetail) => {
    if (!out.some((h) => h.hook === hook)) out.push({ hook, area, turn, ...(detail ? { detail } : {}) });
  };
  for (const e of events) {
    switch (e.type) {
      case 'area_entered':
        if (e.index > 0 || before.area.index !== after.area.index) push('area_enter');
        break;
      case 'region_discovered': {
        const r = after.area.map.regions.find((x) => x.id === e.regionId);
        push('region_discovered', { regionId: e.regionId, ...(r?.name ? { regionName: r.name } : {}) });
        break;
      }
      case 'low_hp':
        push('low_hp');
        break;
      case 'level_up':
        push('milestone', { level: e.level, reason: 'level_up' });
        break;
      case 'quest_updated':
        if (e.status === 'done') push('milestone', { questId: e.questId, reason: 'quest_done' });
        break;
      case 'died': {
        const def = world.actors.find((d) => d.id === e.defId);
        if (def?.unique) push('milestone', { actorId: e.actorId, reason: 'unique_defeated' });
        break;
      }
      case 'game_over':
        push(e.result === 'won' ? 'victory' : 'death', { reason: e.reason });
        break;
    }
  }
  // a unique (boss) comes into view for the first time
  if (after.status === 'playing') {
    const uniques = new Set(world.actors.filter((d) => d.unique && !d.npc).map((d) => d.id));
    for (const a of after.area.actors) {
      if (a.hp <= 0 || !uniques.has(a.defId) || tracker.bossesSeen.includes(a.id)) continue;
      if (!seenNow(after, a.pos)) continue;
      tracker.bossesSeen.push(a.id);
      push('boss_seen', { actorId: a.id });
    }
  }
  return out;
}

/**
 * deriveHooks for a party of 2+ (MP4 design §2.2), from state diffs (no engine change): low_hp per
 * player (its actor's ai.lowHp turning on, or a downed event), throttled per player and area and per
 * PARTY_LOW_HP_TURNS for the party; boss_seen by the first member who sees it; one milestone for a
 * shared level-up; region_discovered at most once per PARTY_REGION_TURNS; area_enter's subject the
 * player whose exit countdown moved the party on.
 */
function derivePartyHooks(world: WorldSpec, before: GameState, after: GameState, events: GameEvent[], tracker: HookTracker): GmHookEvent[] {
  const out: GmHookEvent[] = [];
  const area = after.area.index;
  const turn = after.turn;
  const push = (hook: GmHook, detail?: GmHookDetail) => {
    if (!out.some((h) => h.hook === hook)) out.push({ hook, area, turn, ...(detail ? { detail } : {}) });
  };
  const pidOfActor = (state: GameState, actorId: string | undefined): PlayerId | undefined =>
    actorId ? Object.values(state.players).find((p) => p.actorId === actorId)?.id : undefined;
  const lowHp: { pid: PlayerId; reason?: string }[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'area_entered':
        if (e.index > 0 || before.area.index !== after.area.index) {
          const by = before.area.exitCountdown?.by;
          push('area_enter', by && after.players[by] ? { playerId: by } : undefined);
        }
        break;
      case 'region_discovered': {
        if (tracker.lastRegionTurn !== undefined && turn - tracker.lastRegionTurn < PARTY_REGION_TURNS) break;
        if (out.some((h) => h.hook === 'region_discovered')) break;
        const r = after.area.map.regions.find((x) => x.id === e.regionId);
        push('region_discovered', { regionId: e.regionId, ...(r?.name ? { regionName: r.name } : {}) });
        tracker.lastRegionTurn = turn;
        break;
      }
      case 'downed':
        lowHp.push({ pid: e.playerId, reason: 'downed' });
        break;
      case 'level_up':
        // XP is shared: one hook for the party, whoever's level-up came first
        push('milestone', { level: e.level, reason: 'party_level_up' });
        break;
      case 'quest_updated':
        if (e.status === 'done') push('milestone', { questId: e.questId, reason: 'quest_done' });
        break;
      case 'died': {
        const def = world.actors.find((d) => d.id === e.defId);
        if (!def?.unique) break;
        const killer = pidOfActor(after, e.killerId);
        push('milestone', { actorId: e.actorId, reason: 'unique_defeated', ...(killer ? { playerId: killer } : {}) });
        break;
      }
      case 'game_over':
        push(e.result === 'won' ? 'victory' : 'death', { reason: e.reason });
        break;
    }
  }
  // a member's actor went below the low-hp line this step (the engine's low_hp event names nobody)
  for (const pid of after.party) {
    const id = after.players[pid]?.actorId;
    const now = after.area.actors.find((a) => a.id === id);
    const was = before.area.actors.find((a) => a.id === id);
    if (now?.ai.lowHp && was && !was.ai.lowHp && !lowHp.some((x) => x.pid === pid)) lowHp.push({ pid });
  }
  const lowFree = tracker.lastLowHpTurn === undefined || turn - tracker.lastLowHpTurn >= PARTY_LOW_HP_TURNS;
  const low = lowFree ? lowHp.find((x) => (tracker.lowHpAt ?? {})[x.pid] !== area) : undefined;
  if (low && after.status === 'playing') {
    push('low_hp', { playerId: low.pid, ...(low.reason ? { reason: low.reason } : {}) });
    tracker.lowHpAt = { ...(tracker.lowHpAt ?? {}), [low.pid]: area };
    tracker.lastLowHpTurn = turn;
  }
  // a unique (boss) comes into view of any member for the first time
  if (after.status === 'playing') {
    const uniques = new Set(world.actors.filter((d) => d.unique && !d.npc).map((d) => d.id));
    for (const a of after.area.actors) {
      if (a.hp <= 0 || !uniques.has(a.defId) || tracker.bossesSeen.includes(a.id)) continue;
      const who = after.party.find((pid) => !after.players[pid]?.down && seenNow(after, a.pos, pid));
      if (!who) continue;
      tracker.bossesSeen.push(a.id);
      push('boss_seen', { actorId: a.id, playerId: who });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** keeps only well-formed actions (the engine re-checks references and budget) */
export function sanitizeResponse(r: unknown): GmResponse | null {
  if (!r || typeof r !== 'object') return null;
  const actions = (r as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return null;
  const ok = actions.filter((a): a is GmAction => !!a && typeof a === 'object' && isGmActionType((a as { type?: unknown }).type));
  return ok.length ? { actions: ok.slice(0, 6) } : null;
}

/** the text of the first narrate action (narration cards) */
export function narrationOf(r: GmResponse): string | null {
  const n = r.actions.find((a) => a.type === 'narrate') as { text: string } | undefined;
  return n?.text?.trim() ? n.text.trim() : null;
}
