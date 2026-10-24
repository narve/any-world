/**
 * Engine runtime types — the contract between engine, client (renderer/UI), GM runtime,
 * save files and bots. The engine is pure TypeScript: no DOM, no network, no Date/Math.random.
 * All randomness goes through the seeded RNG stored in GameState.
 *
 * Public engine API (implemented in src/engine/index.ts):
 *
 *   createGame(world: WorldSpec, opts: NewGameOptions): GameState
 *   step(state: GameState, action: PlayerAction): StepResult        // pure: never mutates input
 *   applyGmActions(state: GameState, actions: GmAction[]): StepResult
 *   legalActions(state: GameState): PlayerAction[]                  // for bots & UI hints
 *   describeItem(state, itemInstanceId): ItemView                   // respects player knowledge
 *   describeActor(state, actorInstanceId): ActorView
 *   serialize(state): string / deserialize(world, json): GameState
 */
import type { WorldSpec, Effect, Condition, Knowledge, RuleVariant } from '../schema/world';
import type { GmAction, Difficulty } from '../schema/gm';

export type Dir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export interface Pos { x: number; y: number }

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export type TileKind = 'floor' | 'wall' | 'door' | 'door_open' | 'void' | 'water' | 'transition' | 'start';

export interface Tile {
  kind: TileKind;
  /** custom terrain id from the world spec, if any */
  terrain?: string;
  /** remaining turns for temporary terrain */
  terrainTtl?: number;
  /** room/region index from the generator (for "discovered a room" GM hooks) */
  region?: number;
  /** a lamp is placed here (renderer) */
  lamp?: boolean;
  /** terrain interaction already used (each interactable tile works once) */
  interacted?: boolean;
  /**
   * The terrain (and its interacted flag) covered by temporary terrain; restored when the
   * temporary terrain expires.
   */
  terrainUnder?: { terrain: string; interacted?: boolean };
}

export interface AreaMap {
  width: number;
  height: number;
  /** row-major, index = y * width + x */
  tiles: Tile[];
  start: Pos;
  exit: Pos;
  /** named regions (rooms, buildings, decks) for discovery events */
  regions: { id: number; name?: string; centre: Pos; size: number }[];
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type Faction = 'player' | 'hostile' | 'neutral' | 'friendly';

export interface StatusInstance { id: string; turnsLeft: number; sourceId?: string }

export interface ActorInstance {
  id: string;            // unique instance id, e.g. "a12"
  defId: string;         // ActorDef id, or "player"
  pos: Pos;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  /** base stats (str/dex/int/ac/speed/sight) before modifiers */
  base: { str: number; dex: number; int: number; ac: number; speed: number; sight: number };
  faction: Faction;
  statuses: StatusInstance[];
  /** energy accumulator for speed-based turn order */
  energy: number;
  cooldowns: Record<string, number>;
  /** AI memory (last seen player pos, alert state, home pos for guardians…) */
  ai: {
    alerted: boolean;
    lastSeen?: Pos;
    home?: Pos;
    fleeing?: boolean;
    /** below the low-hp threshold (on_low_hp fires once per crossing) */
    lowHp?: boolean;
    /** wanderer's current destination */
    wander?: Pos;
  };
  /** temporary stat modifiers with durations */
  tempMods: { stat: string; amount: number; turnsLeft: number }[];
  /** allied summon / follower of player */
  allyOf?: string;
  /** npc has been talked to */
  talkedTo?: boolean;
  /** one-off npc services already used (offline dialogue: "heal", "gift", "recruit") */
  npcUsed?: string[];
  /**
   * Def ids this instance had before it transformed, oldest first (a boss's earlier phases).
   * Defeating the instance counts as defeating every one of them.
   */
  formerDefIds?: string[];
}

export interface ItemInstance {
  id: string;          // unique instance id, e.g. "i7"
  defId: string;       // ItemDef id
  count: number;       // stack size
  charges?: number;
  cooldown?: number;
  durability?: number;
}

export interface FloorItem { item: ItemInstance; pos: Pos }

/** generic slots: 0..7 quick-access, 8..27 backpack. null = empty. */
export const QUICK_SLOTS = 8;
export const BACKPACK_SLOTS = 20;
export const TOTAL_SLOTS = QUICK_SLOTS + BACKPACK_SLOTS;

export interface PlayerState {
  actorId: string;           // id of the player's ActorInstance in area.actors
  slots: (ItemInstance | null)[]; // length TOTAL_SLOTS
  /** slot indices of equipped items (items stay in their slot) */
  equipped: { weapon: number | null; armour: number | null; trinket: number | null };
  level: number;
  xp: number;
  perks: string[];
  /** pending level-up choice (perk ids) — blocks other actions until chosen */
  pendingPerkChoice: string[] | null;
  resources: Record<string, number>;   // custom resources
  currency: number;
  sneaking: boolean;
}

/** what the player knows about each ItemDef (by def id) */
export interface ItemKnowledgeState {
  level: Knowledge;
  /** randomised per-run appearance for unknown items */
  appearance?: { label: string; color: string };
  /** free-form notes recorded by the engine on use ("You felt dizzy.") */
  notes: string[];
  timesUsed: number;
}

export interface AreaState {
  index: number;
  map: AreaMap;
  actors: ActorInstance[];
  items: FloorItem[];
  /** per-tile visibility: 0 unseen, 1 remembered, 2 visible now */
  seen: Uint8Array | number[];
  discoveredRegions: number[];
  /** GM budget remaining for this area */
  gmBudget: number;
  /** rules the GM added in this area (at most MAX_GM_RULES_PER_AREA; absent = 0) */
  gmRulesAdded?: number;
  /** rules the GM retired in this area (at most MAX_GM_RULES_PER_AREA; absent = 0) */
  gmRulesRemoved?: number;
}

/** one rule in force (GameState.activeRules) */
export interface ActiveRuleEntry {
  rule: RuleVariant;
  /** a starting rule of the world, or one the GM added during play */
  source: 'world' | 'gm';
  /** when it came into force (world rules: area 0, turn 0) */
  since: { area: number; turn: number };
  /** the GM's in-story announcement */
  reason?: string;
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  giverId?: string;
  complete: Condition;
  reward: GmAction[];
  status: 'active' | 'done' | 'failed';
}

export interface LogMessage {
  turn: number;
  text: string;
  kind: 'info' | 'combat' | 'gm' | 'npc' | 'loot' | 'warning' | 'good' | 'bad' | 'system';
  speaker?: string;
  /**
   * i18n (DESIGN §7b): message-catalog key for engine-generated lines (e.g. "log.attack.hit").
   * `text` remains the English fallback; the client renders `key` + `params` through its catalog
   * when present. World/GM/NPC-authored text has no key (it is already in the world's language).
   */
  key?: string;
  /** catalog params: numbers, or strings that are already world-language names (actor/item/damage names) */
  params?: Record<string, string | number>;
}

export interface GameState {
  version: 1;
  worldId: string;            // hash/slug of the world spec
  seed: number;
  rng: number[];              // PRNG internal state (4 × uint32, sfc32)
  turn: number;
  status: 'playing' | 'won' | 'lost';
  endReason?: string;
  area: AreaState;
  /** areas already visited are dropped (no backtracking in v1) */
  player: PlayerState;
  knowledge: Record<string, ItemKnowledgeState>;
  flags: Record<string, boolean>;
  counters: Record<string, number>;
  defeated: Record<string, number>; // actor def id -> count
  quests: Quest[];
  log: LogMessage[];
  /** open dialogue/choice the player must resolve */
  pendingChoice: PendingChoice | null;
  nextId: number;
  stats: { kills: number; itemsUsed: number; damageDealt: number; damageTaken: number; areasCleared: number };
  /** unique actor def ids spawned at least once this run (record only: a unique may reappear until defeated, see uniqueSpawnable) */
  uniquesSpawned?: string[];
  /** permadeathMercy rule already saved the player once */
  mercyUsed?: boolean;
  /** difficulty band of the run (absent in older saves = 'normal'), see engine/difficulty.ts */
  difficulty?: Difficulty;
  /**
   * The rules in force: the world's starting rules plus GM-added ones, minus retired ones
   * (engine/rules.ts). Absent in older saves, which play with the world's rules.
   */
  activeRules?: ActiveRuleEntry[];
  /**
   * Harm (estimateRuleImpact hpPer100) of the helpful world rules the GM has retired this run.
   * Counts toward the difficulty's ruleHarmTotal together with the GM-added rules (rules.ts).
   */
  gmRetiredHarm?: number;
  /** the last harm the player took (for the loss reason): who and what kind */
  lastHarm?: { by?: string; damageType: string; turn: number };
}

export interface PendingChoice {
  kind: 'gm_offer' | 'dialogue';
  prompt: string;
  speakerId?: string;
  options: { label: string; actions: GmAction[]; /** engine-internal marker (e.g. "service:heal") */ tag?: string }[];
  /** gm_offer only: area GM budget reserved for the options when the offer was made (see gmActionCost) */
  reservedBudget?: number;
}

// ---------------------------------------------------------------------------
// Actions & events
// ---------------------------------------------------------------------------

export type PlayerAction =
  | { type: 'move'; dir: Dir }                         // bump into hostile = attack, into npc = talk
  | { type: 'attack'; targetId: string }               // ranged/explicit attack with equipped weapon
  | { type: 'wait' }
  | { type: 'use'; slot: number; target?: Pos }        // activate slot item (equip weapon, drink, cast…)
  | { type: 'equip'; slot: number }
  | { type: 'unequip'; slot: number }
  | { type: 'move_item'; from: number; to: number }    // swap/move between slots
  | { type: 'drop'; slot: number }
  | { type: 'pickup' }
  | { type: 'transition' }                             // take the area exit
  | { type: 'talk'; targetId: string }
  | { type: 'persuade'; targetId: string }
  | { type: 'search' }
  | { type: 'toggle_sneak' }
  | { type: 'choose_perk'; perkId: string }
  | { type: 'choose_option'; index: number }           // resolve pendingChoice
  | { type: 'interact'; pos: Pos };                    // terrain interaction

export type GameEvent =
  | { type: 'moved'; actorId: string; from: Pos; to: Pos }
  | { type: 'attacked'; attackerId: string; targetId: string; hit: boolean; damage: number; damageType: string; ranged: boolean }
  | { type: 'damaged'; actorId: string; amount: number; damageType: string; sourceId?: string }
  | { type: 'healed'; actorId: string; amount: number }
  | { type: 'died'; actorId: string; defId: string; killerId?: string }
  | { type: 'status_applied'; actorId: string; status: string }
  | { type: 'status_expired'; actorId: string; status: string }
  | { type: 'effect'; vfx: string; color?: string; from: Pos; to: Pos; radius?: number }
  | { type: 'item_picked'; itemId: string; defId: string }
  | { type: 'item_used'; defId: string; consumed: boolean }
  | { type: 'item_identified'; defId: string; level: Knowledge }
  | { type: 'equipped'; slot: number }
  | { type: 'spawned'; actorId: string; defId: string }
  | { type: 'terrain_changed'; positions: Pos[] }
  | { type: 'area_entered'; index: number }
  | { type: 'region_discovered'; regionId: number }
  | { type: 'level_up'; level: number; choices: string[] }
  | { type: 'npc_talk'; actorId: string }
  | { type: 'low_hp' }
  | { type: 'quest_updated'; questId: string; status: Quest['status'] }
  | { type: 'game_over'; result: 'won' | 'lost'; reason: string }
  | { type: 'message'; text: string; kind: LogMessage['kind'] }
  | { type: 'noise'; pos: Pos; radius: number }
  | { type: 'invalid'; reason: string }
  | { type: 'rule_added'; id: string; name: string; source: 'gm'; reason?: string }
  | { type: 'rule_removed'; id: string; name: string; reason?: string }
  /**
   * A GM action the engine refused (over budget, unknown reference, rule limits…). Diagnostics for
   * the GM runtime, debugging and the simulator; never written to the player's log.
   */
  | { type: 'gm_skipped'; action: string; reason: string };

export interface StepResult {
  state: GameState;
  events: GameEvent[];
  /** true if the action consumed a turn */
  tookTurn: boolean;
  /** applyGmActions: the GM actions refused in this call (same as the gm_skipped events) */
  gmSkipped?: { action: string; reason: string }[];
}

export interface NewGameOptions {
  seed: number;
  /** optional pre-generated area map (from tests) */
  map?: AreaMap;
  /** optional map generator override, used for this createGame call (tests, tools) */
  mapGenerator?: MapGenerator;
  /** difficulty band (default 'normal'); stored in GameState.difficulty, see engine/difficulty.ts */
  difficulty?: Difficulty;
}

/** generator contract (src/engine/mapgen) */
export type MapGenerator = (
  plan: WorldSpec['areas'][number],
  world: WorldSpec,
  rng: Rng,
) => AreaMap;

export interface Rng {
  next(): number;              // [0,1)
  int(min: number, max: number): number; // inclusive
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
  dice(spec: string): number;  // "2d6"
  state(): number[];
}

/** UI-facing descriptions that respect player knowledge */
export interface ItemView {
  name: string;
  kind: string;
  description: string;
  knowledge: Knowledge;
  /** human-readable effect lines, only when known ("Restores 20 Health") */
  effectLines: string[];
  vagueText?: string;
  notes: string[];
  count: number;
  charges?: number;
  equipped: boolean;
  usable: boolean;
  color: string;
}

export interface ActorView {
  name: string;
  description: string;
  hp: number;
  maxHp: number;
  faction: Faction;
  statuses: string[];
  threat: 'trivial' | 'even' | 'dangerous' | 'deadly';
  isNpc: boolean;
}

export type { Effect, Condition, GmAction, Difficulty };
