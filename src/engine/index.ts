/**
 * Public engine API. Pure and deterministic: every call clones its input state, mutates the clone
 * and returns it; all randomness comes from the sfc32 state stored in GameState.rng.
 *
 * The world spec is not stored inside GameState (it is large and immutable). createGame and
 * deserialize register it by `worldId`; step/applyGmActions/legalActions/describe* look it up,
 * or take it explicitly through the optional `env` argument.
 */
import type { WorldSpec } from '../schema/world';
import type { GmAction } from '../schema/gm';
import type {
  ActorInstance,
  ActorView,
  AreaMap,
  GameEvent,
  GameState,
  ItemView,
  MapGenerator,
  NewGameOptions,
  PlayerAction,
  PlayerId,
  PlayerState,
  StepResult,
  TurnInput,
  TurnOptions,
  TurnResult,
} from './types';
import { TOTAL_SLOTS } from './types';
import { generateArea } from './mapgen/index';
import { type Ctx, type EngineProfile, findFreeNear, indexWorld, leadOf, me, nextId, playerActor, playerActorOf, withPlayer } from './ctx';
import { createRng, rngFromState } from './rng';
import { initKnowledge } from './knowledge';
import { addInstance, equipSlotOf, makeItem } from './inventory';
import { enterArea, nearestFreeFloor } from './area';
import { updateFov } from './vision';
import { ACT_COST, checkEnd } from './turn';
import { readyIds, runTurn } from './party';
import { applyGmList, checkQuests, gmSkip } from './gm';
import { computeLegalActions } from './legal';
import { findItemInstance, viewActor, viewItem } from './describe';
import { fireItemTriggers } from './triggers';
import { registerWorld, registry } from './registry';
import { passable } from './ctx';
import { energyGain, getStat, maxHp, maxMp, sightRadius } from './stats';
import { xpToNext } from './progression';
import { transitionFailure } from './area';
import { persuadeChance } from './npc';
import { MAX_PARTY_SIZE, isDifficulty } from './difficulty';
import { initialActiveRules } from './rules';
import { cloneState } from './clone';
import { own } from './util';

export interface EngineEnv {
  /** the world spec (defaults to the registered one for state.worldId) */
  world?: WorldSpec;
  /** map generator for area transitions (defaults to mapgen's generateArea) */
  mapGenerator?: MapGenerator;
  /** the player a call acts or answers for (defaults to the lead player, party[0]) */
  playerId?: PlayerId;
  /**
   * Timing hooks: the caller's clock and a sink for the time per key ('turn', 'world', 'ai',
   * 'fov'). The engine itself never reads a clock; without this it does no timing.
   */
  profile?: EngineProfile;
}

function worldFor(state: GameState, env?: EngineEnv): WorldSpec {
  const w = env?.world ?? registry.get(state.worldId);
  if (!w) throw new Error(`world "${state.worldId}" is not registered; call createGame/deserialize or pass env.world`);
  return w;
}

/** a working context on a copy of `state` (copy-on-write map tiles, see clone.ts) */
function clonedCtx(world: WorldSpec, state: GameState, env?: EngineEnv): Ctx {
  const { state: s, cow } = cloneState(state);
  const ctx = makeCtx(world, s, env);
  ctx.cow = cow;
  return ctx;
}

function makeCtx(world: WorldSpec, s: GameState, env?: EngineEnv): Ctx {
  return {
    world,
    ix: indexWorld(world),
    s,
    pid: env?.playerId ?? s.party[0],
    rng: rngFromState(s.rng),
    events: [],
    mapGen: env?.mapGenerator ?? generateArea,
    depth: 0,
    ...(env?.profile ? { profile: env.profile } : {}),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** turns of the exit countdown when NewGameOptions.exitCountdownTurns is not given */
export const DEFAULT_EXIT_COUNTDOWN_TURNS = 5;

/** the lead player (party[0]); a single player is a party of one */
export function leadPlayer(state: GameState): PlayerState {
  return state.players[state.party[0]];
}

/**
 * A shallow copy of `state` with some of one player's fields replaced (default: the lead), for
 * callers that preview a state ("as if the choice were closed"); `state` itself is not changed.
 */
export function patchPlayer(state: GameState, patch: Partial<PlayerState>, pid: PlayerId = state.party[0]): GameState {
  return { ...state, players: { ...state.players, [pid]: { ...state.players[pid], ...patch } } };
}

/** player ids in party (join) order */
export function playerIds(state: GameState): PlayerId[] {
  return state.party.slice();
}

/** a fresh player actor at level 1 (placed by enterArea / addPlayer) */
function newPlayerActor(world: WorldSpec, id: string): ActorInstance {
  const ps = world.player;
  return {
    id,
    defId: 'player',
    pos: { x: 0, y: 0 },
    hp: ps.stats.hp,
    maxHp: ps.stats.hp,
    mp: ps.stats.mp,
    maxMp: ps.stats.mp,
    base: { str: ps.stats.str, dex: ps.stats.dex, int: ps.stats.int, ac: ps.stats.ac, speed: 100, sight: ps.sight },
    faction: 'player',
    statuses: [],
    energy: ACT_COST,
    cooldowns: {},
    ai: { alerted: false },
    tempMods: [],
  };
}

/** a new player's state: level 1, empty pack, the given knowledge table */
function newPlayerState(world: WorldSpec, id: PlayerId, name: string, actorId: string, knowledge: PlayerState['knowledge']): PlayerState {
  return {
    id,
    name,
    actorId,
    slots: Array.from({ length: TOTAL_SLOTS }, () => null),
    equipped: { weapon: null, armour: null, trinket: null },
    level: 1,
    xp: 0,
    perks: [],
    pendingPerkChoice: null,
    resources: Object.fromEntries((world.resources ?? []).map((r) => [r.id, Math.min(r.start, r.max)])),
    sneaking: false,
    knowledge,
    pendingChoice: null,
    seen: new Uint8Array(1),
  };
}

/**
 * A knowledge table for a player joining with nothing learned: the same appearances as `from`
 * (so "the blue vial" is the same item for everyone), each item at its starting level.
 */
function freshKnowledge(ctx: Ctx, from: PlayerState['knowledge']): PlayerState['knowledge'] {
  const out: PlayerState['knowledge'] = {};
  for (const [id, k] of Object.entries(from)) {
    const def = ctx.ix.items.get(id);
    const level = k.ruleHidden ? 'unknown' : (def?.knowledge ?? k.level);
    out[id] = { level, notes: [], timesUsed: 0, ...(k.appearance ? { appearance: { ...k.appearance } } : {}), ...(k.ruleHidden ? { ruleHidden: true } : {}) };
  }
  return out;
}

/** the world's starting items into the acting player's pack; returns the slots to equip */
function giveStartingKit(ctx: Ctx): number[] {
  const ps = me(ctx);
  const toEquip: number[] = [];
  for (const si of ctx.world.player.startingItems) {
    const def = ctx.ix.items.get(si.item);
    if (!def) continue;
    const units = def.stackable ? [si.count] : Array.from({ length: si.count }, () => 1);
    for (const n of units) {
      const it = makeItem(ctx, def.id, n);
      if (!it) continue;
      const slot = addInstance(ctx, it, si.quick);
      if (slot < 0) continue;
      const kind = equipSlotOf(def);
      if (si.equipped && kind && ps.equipped[kind] === null) {
        ps.equipped[kind] = slot;
        toEquip.push(slot);
      }
    }
  }
  return toEquip;
}

/** on_equip of the starting kit, once the player stands in the area */
function equipStartingKit(ctx: Ctx, slots: number[]): void {
  const ps = me(ctx);
  for (const slot of slots) {
    const it = ps.slots[slot];
    const def = it ? ctx.ix.items.get(it.defId) : undefined;
    if (def) fireItemTriggers(ctx, playerActor(ctx), def, 'on_equip');
  }
  const pa = playerActor(ctx);
  pa.hp = Math.max(1, pa.hp);
}

/** the next free player id (p1, p2…; never reused) */
function nextPlayerId(s: GameState): PlayerId {
  let n = 0;
  for (const id of Object.keys(s.players)) n = Math.max(n, Number(/^p(\d+)$/.exec(id)?.[1] ?? 0));
  return `p${n + 1}`;
}

export function createGame(world: WorldSpec, opts: NewGameOptions): GameState {
  const worldId = registerWorld(world);
  const rng = createRng(opts.seed);
  const player = newPlayerActor(world, 'a1');
  const placeholder: AreaMap = { width: 1, height: 1, tiles: [{ kind: 'floor' }], start: { x: 0, y: 0 }, exit: { x: 0, y: 0 }, regions: [] };
  // appearances are rolled once (before any item id is made) and every player starts with a copy
  const knowledge = initKnowledge(world, rng);
  const names = (Array.isArray(opts.players) && opts.players.length ? opts.players : [{ name: world.player.name }]).slice(0, MAX_PARTY_SIZE);
  const lead = newPlayerState(world, 'p1', String(names[0]?.name || world.player.name), player.id, knowledge);
  const s: GameState = {
    version: 2,
    worldId,
    seed: opts.seed,
    rng: [],
    turn: 0,
    status: 'playing',
    area: { index: -1, map: placeholder, actors: [player], items: [], discoveredRegions: [], gmBudget: 0 },
    players: { [lead.id]: lead },
    party: [lead.id],
    purse: world.player.startCurrency ?? 0,
    partyRules: { exitCountdownTurns: Math.max(1, Math.round(opts.exitCountdownTurns ?? DEFAULT_EXIT_COUNTDOWN_TURNS)) },
    flags: {},
    counters: {},
    defeated: {},
    quests: [],
    log: [],
    nextId: 2,
    stats: { kills: 0, itemsUsed: 0, damageDealt: 0, damageTaken: 0, areasCleared: 0 },
    uniquesSpawned: [],
    difficulty: isDifficulty(opts.difficulty) ? opts.difficulty : 'normal',
    activeRules: initialActiveRules(world),
  };
  const ctx: Ctx = { world, ix: indexWorld(world), s, pid: lead.id, rng, events: [], mapGen: opts.mapGenerator ?? generateArea, depth: 0 };
  const kits = new Map<PlayerId, number[]>([[lead.id, giveStartingKit(ctx)]]);
  // the rest of the party after the lead's kit, so a party of one keeps its rng and ids
  for (const n of names.slice(1)) {
    const id = nextPlayerId(s);
    const a = newPlayerActor(world, nextId(ctx, 'a'));
    s.area.actors.push(a);
    s.players[id] = newPlayerState(world, id, String(n?.name || `${world.player.name} ${s.party.length + 1}`), a.id, freshKnowledge(ctx, knowledge));
    s.party.push(id);
    kits.set(id, withPlayer(ctx, id, () => giveStartingKit(ctx)));
  }
  enterArea(ctx, 0, opts.map);
  for (const id of s.party) withPlayer(ctx, id, () => equipStartingKit(ctx, kits.get(id) ?? []));
  updateFov(ctx);
  s.rng = rng.state();
  return s;
}

/**
 * Adds a player to a running game (a late joiner, MP2): level 1 with the world's starting kit and
 * the party's item appearances, placed on a free tile next to the lead. Pure: `state` is not
 * changed. The party grows to at most MAX_PARTY_SIZE.
 */
export function addPlayer(state: GameState, opts: { name: string }, env?: EngineEnv): { state: GameState; playerId: PlayerId } {
  const world = worldFor(state, env);
  if (state.status !== 'playing') throw new Error('the run is over');
  if (state.party.length >= MAX_PARTY_SIZE) throw new Error(`the party is full (${MAX_PARTY_SIZE})`);
  const ctx = clonedCtx(world, state, env);
  const s = ctx.s;
  const lead = leadOf(s);
  const leadActor = playerActorOf(ctx, lead.id);
  const id = nextPlayerId(s);
  const a = newPlayerActor(world, nextId(ctx, 'a'));
  a.pos = (leadActor && (findFreeNear(ctx, leadActor.pos, 3) ?? nearestFreeFloor(ctx, leadActor.pos))) ?? nearestFreeFloor(ctx, s.area.map.start) ?? { ...s.area.map.start };
  s.area.actors.push(a);
  const ps = newPlayerState(world, id, String(opts?.name || `${world.player.name} ${s.party.length + 1}`), a.id, freshKnowledge(ctx, lead.knowledge));
  ps.seen = new Uint8Array(s.area.map.width * s.area.map.height);
  s.players[id] = ps;
  s.party.push(id);
  withPlayer(ctx, id, () => equipStartingKit(ctx, giveStartingKit(ctx)));
  updateFov(ctx);
  s.rng = ctx.rng.state();
  return { state: s, playerId: id };
}

function finish(ctx: Ctx, tookTurn: boolean): StepResult {
  if (ctx.s.status === 'playing') checkEnd(ctx);
  updateFov(ctx);
  ctx.s.rng = ctx.rng.state();
  return { state: ctx.s, events: ctx.events, tookTurn };
}

/**
 * One party turn: every player's input (free actions first, at most one turn action each), then
 * the world moves once (engine/party.ts). Never mutates `state`; when nothing changed (every
 * action refused, no busy flag, no `advance`) the input state is returned with the refusals.
 */
export function stepTurn(state: GameState, inputs: TurnInput[], env?: EngineEnv & TurnOptions): TurnResult {
  const world = worldFor(state, env);
  if (state.status !== 'playing') {
    const outcomes = (Array.isArray(inputs) ? inputs : []).flatMap((i) =>
      (i?.actions ?? []).map((action) => ({ playerId: i.playerId, action, ok: false, tookTurn: false, reason: 'stale' as const, detail: 'the run is over' })),
    );
    return { state, events: [{ type: 'invalid', reason: 'the run is over' }], tookTurn: false, outcomes, waited: [] };
  }
  const ctx = clonedCtx(world, state, env);
  const r = runTurn(ctx, inputs, env?.advance ? { advance: true } : {});
  if (!r.changed) return { state, events: ctx.events, tookTurn: false, outcomes: r.outcomes, waited: [] };
  return { state: ctx.s, events: ctx.events, tookTurn: r.tookTurn, outcomes: r.outcomes, waited: r.waited };
}

/** applies one player action (a party turn with one input); never mutates `state` (invalid actions return it unchanged) */
export function step(state: GameState, action: PlayerAction, env?: EngineEnv): StepResult {
  const r = stepTurn(state, [{ playerId: env?.playerId ?? state.party[0], actions: [action] }], env ? { ...env, advance: false } : undefined);
  return { state: r.state, events: r.events, tookTurn: r.tookTurn };
}

/** players whose input a party turn waits for: standing, energy ≥ ACT_COST, not stunned (party order) */
export function readyPlayers(state: GameState, env?: EngineEnv): PlayerId[] {
  const world = worldFor(state, env);
  if (state.status !== 'playing') return [];
  return readyIds(makeCtx(world, state, env));
}

/**
 * applies GM actions within the area's GM budget; refused ones (over budget, invalid references,
 * rule limits) become `gm_skipped` events and StepResult.gmSkipped, never player log lines
 */
export function applyGmActions(state: GameState, actions: GmAction[], env?: EngineEnv): StepResult {
  const world = worldFor(state, env);
  if (state.status !== 'playing') return { state, events: [], tookTurn: false };
  const ctx = clonedCtx(world, state, env);
  for (const a of Array.isArray(actions) ? actions : []) {
    try {
      applyGmList(ctx, [a], { charge: true });
    } catch {
      gmSkip(ctx, String((a as { type?: unknown })?.type ?? 'action'), 'malformed');
    }
  }
  checkQuests(ctx);
  const r = finish(ctx, false);
  r.gmSkipped = r.events.filter((e): e is Extract<GameEvent, { type: 'gm_skipped' }> => e.type === 'gm_skipped').map((e) => ({ action: e.action, reason: e.reason }));
  return r;
}

export function legalActions(state: GameState, env?: EngineEnv): PlayerAction[] {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  return computeLegalActions(ctx);
}

export function describeItem(state: GameState, itemInstanceId: string, env?: EngineEnv): ItemView {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  const found = findItemInstance(ctx, itemInstanceId);
  if (!found) throw new Error(`no item instance "${itemInstanceId}"`);
  return viewItem(ctx, found.item, found.slot);
}

export function describeActor(state: GameState, actorInstanceId: string, env?: EngineEnv): ActorView {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  const a = ctx.s.area.actors.find((x) => x.id === actorInstanceId);
  if (!a) throw new Error(`no actor instance "${actorInstanceId}"`);
  return viewActor(ctx, a);
}

// ---------------------------------------------------------------------------
// Read-only queries for the client (one cloned context per call)
// ---------------------------------------------------------------------------

/** the player's effective numbers, as the HUD shows them */
export interface PlayerSheet {
  str: number;
  dex: number;
  int: number;
  ac: number;
  /** effective energy per round (100 = normal; hasted/slowed applied) */
  speed: number;
  sight: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  /** xp gathered toward the next level, and the amount the next level needs */
  xp: number;
  xpToNext: number;
  resources: { id: string; value: number; max: number }[];
}

export function playerSheet(state: GameState, env?: EngineEnv): PlayerSheet {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  const p = playerActor(ctx);
  const ps = me(ctx);
  return {
    str: getStat(ctx, p, 'str'),
    dex: getStat(ctx, p, 'dex'),
    int: getStat(ctx, p, 'int'),
    ac: getStat(ctx, p, 'ac'),
    speed: energyGain(ctx, p),
    sight: sightRadius(ctx, p),
    hp: p.hp,
    maxHp: maxHp(ctx, p),
    mp: p.mp,
    maxMp: maxMp(ctx, p),
    xp: ps.xp,
    xpToNext: xpToNext(ctx, ps.level),
    resources: (world.resources ?? []).map((r) => ({ id: r.id, value: own(ps.resources, r.id) ?? 0, max: r.max })),
  };
}

/**
 * A predicate "could an actor stand on (x, y)" for the current area (terrain included, other
 * actors ignored), for client-side path finding. Read-only; valid until the area changes.
 */
export function passability(state: GameState, env?: EngineEnv): (x: number, y: number) => boolean {
  const world = worldFor(state, env);
  const ctx = makeCtx(world, state, env);
  return (x, y) => passable(ctx, x, y);
}

/** chance (0–1) that persuading the actor works right now; null when there is no such actor */
export function persuadeOdds(state: GameState, actorInstanceId: string, env?: EngineEnv): number | null {
  const world = worldFor(state, env);
  const ctx = makeCtx(world, state, env);
  const a = state.area.actors.find((x) => x.id === actorInstanceId && x.hp > 0);
  return a ? persuadeChance(ctx, a) : null;
}

/** why the player can't take the area exit right now (null = they can) */
export function transitionBlocker(state: GameState, env?: EngineEnv): string | null {
  if (state.status !== 'playing') return 'the run is over';
  const world = worldFor(state, env);
  return transitionFailure(clonedCtx(world, state, env));
}

/** ItemViews for all 28 slots in one go (null for empty slots) */
export function describeInventory(state: GameState, env?: EngineEnv): (ItemView | null)[] {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  return me(ctx).slots.map((it, i) => (it ? viewItem(ctx, it, i) : null));
}

/** ItemView for an item kind the player doesn't hold (trader stock, rewards), respecting knowledge */
export function describeItemDef(state: GameState, defId: string, env?: EngineEnv): ItemView {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  const def = ctx.ix.items.get(defId);
  return viewItem(ctx, { id: `preview-${defId}`, defId, count: 1, ...(def?.charges ? { charges: def.charges } : {}) }, null);
}

export { serialize, deserialize } from './serialize';
export { hashState } from './hash';
export { LOG_KEYS, END_REASON_KEYS, DEATH_REASON_KEYS, FACTION_KEYS, renderTemplate, renderLogKey, templateParams, type LogKey, type EndReasonKey, type LogParams } from './log-keys';
export { endingText } from './ctx';
export {
  buildGmContext,
  estimateTokens,
  GM_CONTEXT_MAX_TOKENS,
  GM_CONTEXT_VERSION,
  type GmContextSummary,
  type GmContextHook,
  type GmContextItem,
  type GmContextActor,
  type GmContextOptions,
} from './gm-context';
export { sellPrice, MAX_SELL_OPTIONS } from './npc';
export {
  DIFFICULTIES,
  DIFFICULTY_PROFILES,
  MAX_PARTY_SIZE,
  PARTY_SCALING,
  difficultyOf,
  isDifficulty,
  partyFactor,
  type DifficultyProfile,
} from './difficulty';
export { estimateRuleImpact, activeRuleEntries, type RuleImpact } from './rules';
export { registerWorld, getWorld, worldIdOf } from './registry';
export { createRng, rngFromState, SeededRng } from './rng';
export { computeFov, hasLos, withinRadius, withinReach } from './fov';
export { MAX_AREA_ACTORS, areaActorCap } from './actors';
export { findPath, bfsDistances } from './path';
export type * from './types';
export { QUICK_SLOTS, BACKPACK_SLOTS, TOTAL_SLOTS } from './types';
