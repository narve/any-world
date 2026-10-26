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
  StepResult,
} from './types';
import { TOTAL_SLOTS } from './types';
import { generateArea } from './mapgen/index';
import { type Ctx, indexWorld, log, playerActor } from './ctx';
import { createRng, rngFromState } from './rng';
import { initKnowledge } from './knowledge';
import { addInstance, equipSlotOf, makeItem } from './inventory';
import { enterArea } from './area';
import { updateFov } from './vision';
import { doPlayerAction } from './actions';
import { ACT_COST, checkEnd, runWorld } from './turn';
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
import { isDifficulty } from './difficulty';
import { initialActiveRules } from './rules';
import { cloneState } from './clone';
import { own } from './util';

export interface EngineEnv {
  /** the world spec (defaults to the registered one for state.worldId) */
  world?: WorldSpec;
  /** map generator for area transitions (defaults to mapgen's generateArea) */
  mapGenerator?: MapGenerator;
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
    rng: rngFromState(s.rng),
    events: [],
    mapGen: env?.mapGenerator ?? generateArea,
    depth: 0,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function createGame(world: WorldSpec, opts: NewGameOptions): GameState {
  const worldId = registerWorld(world);
  const rng = createRng(opts.seed);
  const ps = world.player;
  const player: ActorInstance = {
    id: 'a1',
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
  const placeholder: AreaMap = { width: 1, height: 1, tiles: [{ kind: 'floor' }], start: { x: 0, y: 0 }, exit: { x: 0, y: 0 }, regions: [] };
  const s: GameState = {
    version: 1,
    worldId,
    seed: opts.seed,
    rng: [],
    turn: 0,
    status: 'playing',
    area: { index: -1, map: placeholder, actors: [player], items: [], seen: new Uint8Array(1), discoveredRegions: [], gmBudget: 0 },
    player: {
      actorId: player.id,
      slots: Array.from({ length: TOTAL_SLOTS }, () => null),
      equipped: { weapon: null, armour: null, trinket: null },
      level: 1,
      xp: 0,
      perks: [],
      pendingPerkChoice: null,
      resources: Object.fromEntries((world.resources ?? []).map((r) => [r.id, Math.min(r.start, r.max)])),
      currency: world.player.startCurrency ?? 0,
      sneaking: false,
    },
    knowledge: initKnowledge(world, rng),
    flags: {},
    counters: {},
    defeated: {},
    quests: [],
    log: [],
    pendingChoice: null,
    nextId: 2,
    stats: { kills: 0, itemsUsed: 0, damageDealt: 0, damageTaken: 0, areasCleared: 0 },
    uniquesSpawned: [],
    difficulty: isDifficulty(opts.difficulty) ? opts.difficulty : 'normal',
    activeRules: initialActiveRules(world),
  };
  const ctx: Ctx = { world, ix: indexWorld(world), s, rng, events: [], mapGen: opts.mapGenerator ?? generateArea, depth: 0 };
  // starting items
  const toEquip: number[] = [];
  for (const si of ps.startingItems) {
    const def = ctx.ix.items.get(si.item);
    if (!def) continue;
    const units = def.stackable ? [si.count] : Array.from({ length: si.count }, () => 1);
    for (const n of units) {
      const it = makeItem(ctx, def.id, n);
      if (!it) continue;
      const slot = addInstance(ctx, it, si.quick);
      if (slot < 0) continue;
      const kind = equipSlotOf(def);
      if (si.equipped && kind && s.player.equipped[kind] === null) {
        s.player.equipped[kind] = slot;
        toEquip.push(slot);
      }
    }
  }
  enterArea(ctx, 0, opts.map);
  for (const slot of toEquip) {
    const it = s.player.slots[slot];
    const def = it ? ctx.ix.items.get(it.defId) : undefined;
    if (def) fireItemTriggers(ctx, playerActor(ctx), def, 'on_equip');
  }
  const pa = playerActor(ctx);
  pa.hp = Math.max(1, pa.hp);
  updateFov(ctx);
  s.rng = rng.state();
  return s;
}

function finish(ctx: Ctx, tookTurn: boolean): StepResult {
  if (ctx.s.status === 'playing') checkEnd(ctx);
  updateFov(ctx);
  ctx.s.rng = ctx.rng.state();
  return { state: ctx.s, events: ctx.events, tookTurn };
}

/** applies one player action; never mutates `state` (invalid actions return it unchanged) */
export function step(state: GameState, action: PlayerAction, env?: EngineEnv): StepResult {
  const world = worldFor(state, env);
  if (state.status !== 'playing') {
    return { state, events: [{ type: 'invalid', reason: 'the run is over' }], tookTurn: false };
  }
  const ctx = clonedCtx(world, state, env);
  const r = doPlayerAction(ctx, action);
  if (!r.ok) {
    const events: GameEvent[] = [{ type: 'invalid', reason: r.reason ?? 'not possible' }];
    return { state, events, tookTurn: false };
  }
  if (r.tookTurn) {
    const p = playerActor(ctx);
    p.energy -= r.cost ?? ACT_COST;
    runWorld(ctx);
  } else {
    checkQuests(ctx);
  }
  return finish(ctx, r.tookTurn);
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
    xp: ctx.s.player.xp,
    xpToNext: xpToNext(ctx, ctx.s.player.level),
    resources: (world.resources ?? []).map((r) => ({ id: r.id, value: own(ctx.s.player.resources, r.id) ?? 0, max: r.max })),
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
  return ctx.s.player.slots.map((it, i) => (it ? viewItem(ctx, it, i) : null));
}

/** ItemView for an item kind the player doesn't hold (trader stock, rewards), respecting knowledge */
export function describeItemDef(state: GameState, defId: string, env?: EngineEnv): ItemView {
  const world = worldFor(state, env);
  const ctx = clonedCtx(world, state, env);
  const def = ctx.ix.items.get(defId);
  return viewItem(ctx, { id: `preview-${defId}`, defId, count: 1, ...(def?.charges ? { charges: def.charges } : {}) }, null);
}

export { serialize, deserialize } from './serialize';
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
export { DIFFICULTIES, DIFFICULTY_PROFILES, difficultyOf, isDifficulty, type DifficultyProfile } from './difficulty';
export { estimateRuleImpact, activeRuleEntries, type RuleImpact } from './rules';
export { registerWorld, getWorld, worldIdOf } from './registry';
export { createRng, rngFromState, SeededRng } from './rng';
export { computeFov, hasLos, withinRadius, withinReach } from './fov';
export { MAX_AREA_ACTORS } from './actors';
export { findPath, bfsDistances } from './path';
export type * from './types';
export { QUICK_SLOTS, BACKPACK_SLOTS, TOTAL_SLOTS } from './types';
