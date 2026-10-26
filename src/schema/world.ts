/**
 * World Spec — the contract between the AI (which writes it), the engine (which runs it),
 * the renderer (which draws it) and the audio system (which scores it).
 *
 * Design rules:
 *  - The AI composes engine building blocks; it never writes code.
 *  - Everything here is genre-neutral. Flavour lives in names/descriptions/vocabulary.
 *  - Keep it LLM-friendly: flat-ish, explicit discriminators, generous defaults.
 *  - All cross references are by string id and are checked by `validateWorldRefs` (see refs.ts).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Ids that are built-in members of every JavaScript object. Game state keeps counters, flags and
 * defeat counts in plain id-keyed objects, so these are refused as ids (the engine also reads those
 * maps by own property only; M5 issue proto-ids). Only "constructor" passes the id pattern today.
 */
export const RESERVED_IDS: ReadonlySet<string> = new Set(['constructor', 'prototype', '__proto__']);

export const Id = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'ids are lowercase kebab/snake case')
  .refine((id) => !RESERVED_IDS.has(id), { message: 'this id is reserved (built-in object key); pick another, e.g. add a suffix' });
export type Id = z.infer<typeof Id>;

/** CSS hex colour, #rgb or #rrggbb. */
export const Color = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'hex colour like #a0c4ff');
export type Color = z.infer<typeof Color>;

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

/** The six core stats. Worlds rename them via `vocabulary.stats`. */
export const CoreStat = z.enum(['str', 'dex', 'int', 'hp', 'mp', 'ac']);
export type CoreStat = z.infer<typeof CoreStat>;

/** Any stat-like thing an effect can read or change: core stats, speed/sight, or a custom resource id. */
export const StatRef = z.union([CoreStat, z.enum(['speed', 'sight']), Id]);
export type StatRef = z.infer<typeof StatRef>;

/**
 * A stat change from a perk, item, status or modify_stat effect. Bounded so that no schema-valid
 * world can overflow a stat to Infinity/NaN by stacking modifiers (M5 issue extreme-modifiers);
 * shipped worlds use at most ±20.
 */
export const ModifierAmount = z.number().min(-100).max(100);

/**
 * A number the engine computes: base + dice + scale * stat of the source.
 * e.g. { base: 2, dice: "1d6", scale: { stat: "str", factor: 0.5 } }
 */
export const Amount = z.object({
  base: z.number().default(0),
  dice: z
    .string()
    .regex(/^\d{1,2}d\d{1,3}$/, 'dice like 2d6')
    .optional(),
  scale: z
    .object({ stat: StatRef, factor: z.number() })
    .optional(),
});
export type Amount = z.infer<typeof Amount>;

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export const Targeting = z.object({
  shape: z.enum(['self', 'single', 'adjacent', 'ray', 'cone', 'area', 'all_visible']).default('self'),
  /** max distance in tiles from the user (single/ray/cone/area centre). */
  range: z.number().int().min(0).max(20).default(1),
  /** radius for area, length for cone. */
  radius: z.number().int().min(0).max(8).default(0),
  affects: z.enum(['enemies', 'allies', 'all', 'self_only']).default('enemies'),
  /** whether line of sight is required to the target tile. */
  needsLos: z.boolean().default(true),
});
export type Targeting = z.infer<typeof Targeting>;

// ---------------------------------------------------------------------------
// Conditions (recursive)
// ---------------------------------------------------------------------------

/** Who a condition / effect refers to, relative to the context it runs in. */
export const Who = z.enum(['self', 'target', 'player', 'source']);
export type Who = z.infer<typeof Who>;

const Cmp = z.enum(['lt', 'lte', 'eq', 'gte', 'gt']);

export type Condition =
  | { type: 'all'; of: Condition[] }
  | { type: 'any'; of: Condition[] }
  | { type: 'not'; cond: Condition }
  | { type: 'stat'; who: Who; stat: StatRef; cmp: z.infer<typeof Cmp>; value: number; asPercentOfMax?: boolean }
  | { type: 'has_item'; who: Who; item: string; count?: number }
  | { type: 'has_status'; who: Who; status: string }
  | { type: 'flag'; flag: string; value?: boolean }
  | { type: 'counter'; counter: string; cmp: z.infer<typeof Cmp>; value: number }
  | { type: 'actor_defeated'; actor: string; count?: number }
  | { type: 'in_area'; area: number }
  | { type: 'turn'; cmp: z.infer<typeof Cmp>; value: number }
  | { type: 'on_terrain'; who: Who; terrain: string }
  | { type: 'chance'; p: number }
  | { type: 'always' };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('all'), of: z.array(Condition).min(1) }),
    z.object({ type: z.literal('any'), of: z.array(Condition).min(1) }),
    z.object({ type: z.literal('not'), cond: Condition }),
    z.object({
      type: z.literal('stat'),
      who: Who,
      stat: StatRef,
      cmp: Cmp,
      value: z.number(),
      asPercentOfMax: z.boolean().optional(),
    }),
    z.object({ type: z.literal('has_item'), who: Who, item: Id, count: z.number().int().min(1).optional() }),
    z.object({ type: z.literal('has_status'), who: Who, status: Id }),
    z.object({ type: z.literal('flag'), flag: Id, value: z.boolean().optional() }),
    z.object({ type: z.literal('counter'), counter: Id, cmp: Cmp, value: z.number() }),
    z.object({ type: z.literal('actor_defeated'), actor: Id, count: z.number().int().min(1).optional() }),
    z.object({ type: z.literal('in_area'), area: z.number().int().min(0) }),
    z.object({ type: z.literal('turn'), cmp: Cmp, value: z.number().int() }),
    z.object({ type: z.literal('on_terrain'), who: Who, terrain: Id }),
    z.object({ type: z.literal('chance'), p: z.number().min(0).max(1) }),
    z.object({ type: z.literal('always') }),
  ]),
) as z.ZodType<Condition>;

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Effects are applied to every actor/tile selected by the surrounding Targeting
 * (or to `who` where given). The engine is the only place that interprets them.
 */
export const Effect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('damage'), amount: Amount, damageType: Id.default('physical') }),
  z.object({ type: z.literal('heal'), amount: Amount }),
  /** change mp or a custom resource (positive or negative). */
  z.object({ type: z.literal('resource'), resource: StatRef, amount: Amount }),
  /** temporary (duration>0) or permanent (duration omitted) stat change. */
  z.object({ type: z.literal('modify_stat'), stat: StatRef, amount: ModifierAmount, duration: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('apply_status'), status: Id, duration: z.number().int().min(1).max(200).default(5) }),
  z.object({ type: z.literal('remove_status'), status: z.union([Id, z.literal('all_harmful')]) }),
  z.object({ type: z.literal('teleport'), mode: z.enum(['random', 'to_target', 'swap', 'to_exit']).default('random') }),
  z.object({ type: z.literal('push'), distance: z.number().int().min(1).max(6) }),
  z.object({ type: z.literal('pull'), distance: z.number().int().min(1).max(6) }),
  z.object({ type: z.literal('summon'), actor: Id, count: z.number().int().min(1).max(4).default(1), allied: z.boolean().default(false) }),
  z.object({ type: z.literal('spawn_terrain'), terrain: Id, radius: z.number().int().min(0).max(4).default(0), duration: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('spawn_item'), item: Id, count: z.number().int().min(1).max(5).default(1) }),
  z.object({ type: z.literal('reveal_map'), radius: z.number().int().min(0).max(99).default(99) }),
  z.object({ type: z.literal('identify'), scope: z.enum(['one', 'all_carried']).default('one') }),
  z.object({ type: z.literal('transform'), into: Id }),
  z.object({ type: z.literal('light'), radius: z.number().int().min(1).max(10), duration: z.number().int().min(1).max(500) }),
  z.object({ type: z.literal('noise'), radius: z.number().int().min(1).max(20) }),
  z.object({ type: z.literal('grant_xp'), amount: z.number().int().min(1).max(1000) }),
  /** pays the player in the world's currency (M2), e.g. from an on_kill rule, a loot item or a quest token. */
  z.object({ type: z.literal('currency'), amount: z.number().int().min(1).max(100) }),
  z.object({ type: z.literal('set_flag'), flag: Id, value: z.boolean().default(true) }),
  z.object({ type: z.literal('counter'), counter: Id, add: z.number() }),
  z.object({ type: z.literal('change_faction'), faction: z.enum(['hostile', 'neutral', 'friendly']) }),
  z.object({ type: z.literal('message'), text: z.string().max(300) }),
]);
export type Effect = z.infer<typeof Effect>;

/** An effect bundle: optional condition + targeting + effects. */
export const Action = z.object({
  targeting: Targeting.default({ shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: true }),
  condition: Condition.optional(),
  effects: z.array(Effect).min(1).max(8),
  /** VFX hint for the renderer. */
  vfx: z
    .object({
      kind: z.enum(['none', 'bolt', 'burst', 'beam', 'cloud', 'sparkle', 'slash', 'ring']).default('burst'),
      color: Color.optional(),
    })
    .optional(),
});
export type Action = z.infer<typeof Action>;

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const TriggerEvent = z.enum([
  'on_hit', // holder hits something
  'on_hurt', // holder takes damage
  'on_kill', // holder defeats something
  'on_death', // holder is defeated
  'on_turn', // every turn of holder
  'on_enter_tile', // holder steps on a tile
  'on_pickup', // item picked up (item triggers)
  'on_equip',
  'on_unequip',
  'on_area_enter',
  'on_resource_empty', // a custom resource or mp reaches 0
  'on_low_hp', // drops below 30% hp (fires once per crossing)
]);
export type TriggerEvent = z.infer<typeof TriggerEvent>;

export const Trigger = z.object({
  on: TriggerEvent,
  chance: z.number().min(0).max(1).default(1),
  /** for on_turn: fire every N turns. */
  every: z.number().int().min(1).max(100).optional(),
  action: Action,
});
export type Trigger = z.infer<typeof Trigger>;

// ---------------------------------------------------------------------------
// Statuses, damage types, custom resources, terrain
// ---------------------------------------------------------------------------

export const DamageType = z.object({
  id: Id,
  name: z.string().max(40),
  color: Color,
});
export type DamageType = z.infer<typeof DamageType>;

export const StatusDef = z.object({
  id: Id,
  name: z.string().max(40),
  description: z.string().max(200),
  harmful: z.boolean(),
  /** shown as an icon tint / particle colour */
  color: Color,
  /** per-turn effects on the holder */
  perTurn: z.array(Effect).max(4).default([]),
  /** stat changes while the status lasts */
  modifiers: z.array(z.object({ stat: StatRef, amount: ModifierAmount })).max(4).default([]),
  /** special flags the engine understands */
  flags: z
    .array(z.enum(['stunned', 'rooted', 'invisible', 'confused', 'silenced', 'afraid', 'charmed', 'hasted', 'slowed', 'blinded', 'regenerating']))
    .default([]),
});
export type StatusDef = z.infer<typeof StatusDef>;

export const CustomResource = z.object({
  id: Id,
  name: z.string().max(30),
  description: z.string().max(200),
  color: Color,
  max: z.number().int().min(1).max(999),
  start: z.number().int().min(0).max(999),
  /** change per player turn (e.g. -1 for a draining lantern). */
  perTurn: z.number().default(0),
  /** what happens when it hits 0 (on_resource_empty also fires). */
  onEmpty: z.array(Effect).max(4).default([]),
  /** whether 0 means the run is lost. */
  emptyIsDeath: z.boolean().default(false),
});
export type CustomResource = z.infer<typeof CustomResource>;

// ---------------------------------------------------------------------------
// 3D models (AI-composed)
// ---------------------------------------------------------------------------

export const Material = z.enum(['matte', 'metal', 'glass', 'glow', 'cloth', 'wood', 'stone', 'skin']);

export const Part = z.object({
  shape: z.enum(['box', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'pyramid', 'plane']),
  /** size in tile units; a tile is 1×1, a person is ~0.9 tall. */
  size: Vec3,
  pos: Vec3.default([0, 0, 0]),
  /** degrees */
  rot: Vec3.default([0, 0, 0]),
  color: Color,
  material: Material.default('matte'),
  emissive: Color.optional(),
  /** which named attachment group animates this part (e.g. "wing", "head"). */
  group: z.string().max(20).optional(),
});
export type Part = z.infer<typeof Part>;

export const HumanoidParams = z.object({
  height: z.number().min(0.3).max(1.6).default(0.9),
  build: z.enum(['slim', 'average', 'broad', 'round']).default('average'),
  skin: Color,
  top: Color,
  bottom: Color,
  accent: Color.optional(),
  hair: Color.optional(),
  hairStyle: z.enum(['none', 'short', 'long', 'bun', 'mohawk', 'braids']).default('short'),
  headwear: z
    .enum(['none', 'cowboy_hat', 'cap', 'helmet', 'horned_helmet', 'hood', 'crown', 'top_hat', 'fedora', 'headphones', 'halo', 'antenna', 'bandana'])
    .default('none'),
  outfit: z.enum(['plain', 'coat', 'robe', 'armour', 'suit', 'dress', 'spacesuit', 'uniform', 'rags']).default('plain'),
  holding: z.enum(['none', 'sword', 'gun', 'rifle', 'staff', 'book', 'lantern', 'phone', 'axe', 'shield', 'tool', 'wand', 'bottle']).default('none'),
});

export const ModelSpec = z.object({
  archetype: z.enum(['humanoid', 'quadruped', 'flier', 'blob', 'serpent', 'vehicle', 'robot', 'plant', 'prop', 'freeform']),
  /** required for humanoid; ignored otherwise. */
  humanoid: HumanoidParams.optional(),
  /** main/secondary colours used by non-humanoid archetype generators. */
  colors: z.object({ primary: Color, secondary: Color.optional(), accent: Color.optional() }).optional(),
  /** extra parts appended to the archetype (or the whole model for freeform/prop). */
  parts: z.array(Part).max(24).default([]),
  scale: z.number().min(0.2).max(3).default(1),
  idle: z.enum(['none', 'bob', 'sway', 'pulse', 'spin', 'hover', 'flicker']).default('bob'),
  light: z.object({ color: Color, intensity: z.number().min(0).max(5), radius: z.number().min(0).max(8) }).optional(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

// ---------------------------------------------------------------------------
// Abilities, attacks, items, actors
// ---------------------------------------------------------------------------

export const Attack = z.object({
  name: z.string().max(40),
  /** past-tense verb for the log: "slashes", "insults", "shoots". */
  verb: z.string().max(30),
  damage: Amount,
  damageType: Id.default('physical'),
  /** 1 = melee; >1 = ranged (needs LOS). */
  range: z.number().int().min(1).max(12).default(1),
  /** stat used for to-hit: dex default, str for brutish, int for spells/wit. */
  accuracyStat: z.enum(['str', 'dex', 'int']).default('dex'),
});
export type Attack = z.infer<typeof Attack>;

export const Ability = z.object({
  id: Id,
  name: z.string().max(40),
  description: z.string().max(200),
  action: Action,
  cost: z.object({ resource: StatRef, amount: z.number().min(0) }).optional(),
  cooldown: z.number().int().min(0).max(100).default(0),
  /** hint for monster AI on when to use it. */
  useWhen: z.enum(['always', 'target_in_range', 'low_hp', 'ally_hurt', 'start_of_fight']).default('target_in_range'),
});
export type Ability = z.infer<typeof Ability>;

export const Knowledge = z.enum(['clear', 'vague', 'unknown']);
export type Knowledge = z.infer<typeof Knowledge>;

export const ItemDef = z.object({
  id: Id,
  name: z.string().max(40),
  /** genre-flavoured kind label shown in UI: "Tonic", "Six-shooter", "Data shard". */
  kind: z.string().max(30),
  description: z.string().max(300),
  /** mechanical category (affects defaults and bot logic, NOT slot placement). */
  category: z.enum(['weapon', 'armour', 'trinket', 'consumable', 'throwable', 'spell', 'tool', 'clue', 'quest', 'key']),
  equipSlot: z.enum(['weapon', 'armour', 'trinket']).optional(),
  useMode: z.enum(['consumed', 'charges', 'reusable', 'passive']),
  charges: z.number().int().min(1).max(50).optional(),
  /** effect when activated (not needed for passive). */
  onUse: Action.optional(),
  cost: z.object({ resource: StatRef, amount: z.number().min(0) }).optional(),
  cooldown: z.number().int().min(0).max(100).default(0),
  /** weapon stats when equipped as weapon. */
  weapon: Attack.optional(),
  /** armour value when equipped. */
  armour: z.number().int().min(0).max(20).optional(),
  /** stat modifiers while equipped (or carried if `passiveWhenCarried`). */
  modifiers: z.array(z.object({ stat: StatRef, amount: ModifierAmount })).max(4).default([]),
  passiveWhenCarried: z.boolean().default(false),
  triggers: z.array(Trigger).max(3).default([]),
  /** requirements to equip/use. */
  requires: z.array(z.object({ stat: z.enum(['str', 'dex', 'int']), min: z.number().int() })).max(2).default([]),
  stackable: z.boolean().default(false),
  rarity: z.enum(['common', 'uncommon', 'rare', 'unique']).default('common'),
  /** trade value in the world's currency. */
  value: z.number().int().min(0).max(9999).default(10),

  // --- knowledge ---
  knowledge: Knowledge.default('clear'),
  /** shown when knowledge=vague (and after use for 'unknown' items that reveal to vague). */
  vagueText: z.string().max(160).optional(),
  /** what using it reveals: full = becomes clear, vague = becomes vague, none = stays as is. */
  revealOnUse: z.enum(['full', 'vague', 'none']).default('full'),
  /**
   * for unknown items: the appearance group (key into `unknownAppearances`); each item in a group
   * gets a random appearance per run, like classic potion colours.
   */
  appearanceGroup: Id.optional(),
  model: ModelSpec,
});
export type ItemDef = z.infer<typeof ItemDef>;

export const Behaviour = z.object({
  type: z.enum(['chaser', 'kiter', 'coward', 'pack', 'ambusher', 'wanderer', 'guardian', 'stationary', 'follower', 'idle']),
  /** preferred distance for kiters, flee threshold for cowards (fraction of hp), guard radius… */
  param: z.number().optional(),
  /** chance per turn to act erratically (0..1). */
  erratic: z.number().min(0).max(1).default(0),
});
export type Behaviour = z.infer<typeof Behaviour>;

export const NpcSpec = z.object({
  role: z.enum(['trader', 'quest_giver', 'lore', 'ally', 'rival', 'informant', 'healer']),
  personality: z.string().max(200),
  /** opening line used when the GM is offline. */
  greeting: z.string().max(200),
  /** extra canned lines for offline mode. */
  lines: z.array(z.string().max(200)).max(6).default([]),
  /** items for trade (trader) or reward pool (quest_giver). */
  stock: z.array(Id).max(8).default([]),
  /** what they know / want — fed to the GM prompt. */
  secrets: z.string().max(300).optional(),
  wants: z.string().max(200).optional(),
  /** persuade difficulty (stat check target). */
  persuadeStat: z.enum(['str', 'dex', 'int']).default('int'),
  persuadeDifficulty: z.number().int().min(1).max(30).default(12),
});
export type NpcSpec = z.infer<typeof NpcSpec>;

export const ActorDef = z.object({
  id: Id,
  name: z.string().max(40),
  description: z.string().max(300),
  faction: z.enum(['hostile', 'neutral', 'friendly']).default('hostile'),
  stats: z.object({
    hp: z.number().int().min(1).max(500),
    ac: z.number().int().min(0).max(30).default(10),
    str: z.number().int().min(1).max(30).default(10),
    dex: z.number().int().min(1).max(30).default(10),
    int: z.number().int().min(1).max(30).default(10),
    mp: z.number().int().min(0).max(200).default(0),
  }),
  /** 100 = normal; 200 = twice as fast. */
  speed: z.number().int().min(25).max(400).default(100),
  sight: z.number().int().min(1).max(20).default(7),
  attack: Attack.optional(),
  abilities: z.array(Ability).max(4).default([]),
  resistances: z.array(z.object({ damageType: Id, multiplier: z.number().min(0).max(3) })).max(6).default([]),
  behaviour: Behaviour,
  triggers: z.array(Trigger).max(3).default([]),
  loot: z.array(z.object({ item: Id, chance: z.number().min(0).max(1) })).max(4).default([]),
  xp: z.number().int().min(0).max(1000).default(10),
  /** boss / named unique — spawned once. */
  unique: z.boolean().default(false),
  npc: NpcSpec.optional(),
  /** persuade check target for an actor without an npc block (M2). Without it the engine derives one from hp. */
  persuadeDifficulty: z.number().int().min(1).max(30).optional(),
  /** tags help the GM and the balance checker ("undead", "student", "robot"). */
  tags: z.array(z.string().max(20)).max(6).default([]),
  model: ModelSpec,
});
export type ActorDef = z.infer<typeof ActorDef>;

export const TerrainDef = z.object({
  id: Id,
  name: z.string().max(40),
  description: z.string().max(200),
  walkable: z.boolean().default(true),
  blocksSight: z.boolean().default(false),
  /** effects applied to anyone ending a turn on it. */
  onStand: z.array(Effect).max(3).default([]),
  /** extra movement cost multiplier (2 = slow). */
  moveCost: z.number().min(1).max(4).default(1),
  /** can be interacted with (search/use). */
  interact: Action.optional(),
  color: Color,
  height: z.number().min(0).max(2).default(0),
  emissive: Color.optional(),
  model: ModelSpec.optional(),
});
export type TerrainDef = z.infer<typeof TerrainDef>;

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const Perk = z.object({
  id: Id,
  name: z.string().max(40),
  description: z.string().max(200),
  /** permanent stat changes */
  modifiers: z.array(z.object({ stat: StatRef, amount: ModifierAmount })).max(4).default([]),
  /** abilities/items granted (spells become slot items) */
  grantItems: z.array(Id).max(2).default([]),
  triggers: z.array(Trigger).max(2).default([]),
  /** earliest character level it may be offered */
  minLevel: z.number().int().min(2).max(20).default(2),
});
export type Perk = z.infer<typeof Perk>;

export const PlayerSpec = z.object({
  name: z.string().max(40),
  title: z.string().max(60),
  description: z.string().max(300),
  stats: z.object({
    str: z.number().int().min(1).max(20),
    dex: z.number().int().min(1).max(20),
    int: z.number().int().min(1).max(20),
    hp: z.number().int().min(5).max(200),
    mp: z.number().int().min(0).max(100),
    ac: z.number().int().min(0).max(20),
  }),
  /** mp regenerated per N turns */
  mpRegenEvery: z.number().int().min(1).max(50).default(5),
  hpRegenEvery: z.number().int().min(0).max(50).default(0),
  sight: z.number().int().min(2).max(15).default(8),
  unarmed: Attack,
  startingItems: z
    .array(z.object({ item: Id, count: z.number().int().min(1).max(20).default(1), equipped: z.boolean().default(false), quick: z.boolean().default(true) }))
    .max(10),
  /** currency in hand at the start of a run (M2), so traders are usable without a GM handing out money. */
  startCurrency: z.number().int().min(0).max(9999).optional(),
  growth: z.object({
    /** xp needed for level 2; each further level multiplies by `curve`. */
    firstLevelXp: z.number().int().min(5).max(500).default(30),
    curve: z.number().min(1).max(3).default(1.6),
    hpPerLevel: z.number().int().min(0).max(30).default(4),
    mpPerLevel: z.number().int().min(0).max(20).default(2),
    /** number of perk choices offered on level-up */
    choices: z.number().int().min(2).max(3).default(3),
    perks: z.array(Perk).min(4).max(16),
  }),
  model: ModelSpec,
});
export type PlayerSpec = z.infer<typeof PlayerSpec>;

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export const Generator = z.enum([
  'rooms', 'caves', 'open', 'town', 'building', 'ship', 'maze', 'arena',
  // non-realistic layouts (M2)
  'islands',   // floating platforms over a void, joined by narrow bridges
  'organic',   // membranes, blobs and tubes — insides of creatures, dream-flesh, coral
  'geometric', // abstract symmetric patterns, concentric rings, tessellations
]);
export type Generator = z.infer<typeof Generator>;

export const Lighting = z.object({
  ambient: Color,
  ambientIntensity: z.number().min(0).max(2).default(0.4),
  /** "sun"/"moon" directional light; omit indoors. */
  sun: z.object({ color: Color, intensity: z.number().min(0).max(3), elevation: z.number().min(5).max(90).default(50) }).optional(),
  fog: z.object({ color: Color, density: z.number().min(0).max(0.2) }).optional(),
  /** scattered light sources (torches, neon, lamps, bioluminescence). */
  lamps: z.object({ color: Color, intensity: z.number().min(0).max(5), frequency: z.number().min(0).max(1), flicker: z.boolean().default(false) }).optional(),
  /** player's personal light radius (lantern, flashlight); 0 = none. */
  playerLight: z.number().min(0).max(10).default(4),
  sky: Color.optional(),
});
export type Lighting = z.infer<typeof Lighting>;

export const SurfaceStyle = z.object({
  color: Color,
  color2: Color.optional(),
  material: Material.default('stone'),
  /** wall height in tiles (only for walls). */
  height: z.number().min(0.2).max(3).optional(),
  /** surface pattern hint. */
  pattern: z
    .enum([
      'plain', 'tiles', 'planks', 'grass', 'metal_plates', 'cobble', 'carpet', 'sand', 'water', 'snow',
      // abstract (M2)
      'gradient', 'grid', 'noise', 'lines', 'none',
    ])
    .default('plain'),
});

export const AreaPlan = z.object({
  name: z.string().max(60),
  description: z.string().max(400),
  generator: Generator,
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  /** generator-specific knobs; unknown keys ignored. e.g. { roomCount: 8, openness: 0.3, buildings: 6 } */
  params: z.record(z.string(), z.number()).default({}),
  floor: SurfaceStyle,
  wall: SurfaceStyle,
  lighting: Lighting,
  /** weighted spawn table */
  actors: z.array(z.object({ actor: Id, weight: z.number().min(0).max(100).default(10), min: z.number().int().min(0).max(20).default(0), max: z.number().int().min(0).max(30).default(4) })).max(10),
  /** guaranteed placements (bosses, NPCs) */
  placed: z.array(z.object({ actor: Id, where: z.enum(['anywhere', 'near_start', 'near_exit', 'far', 'centre']).default('anywhere') })).max(6).default([]),
  items: z.array(z.object({ item: Id, weight: z.number().min(0).max(100).default(10) })).max(16),
  itemCount: z.number().int().min(0).max(30).default(6),
  /** guaranteed item placements (keys, clues, goal items) */
  placedItems: z.array(z.object({ item: Id, where: z.enum(['anywhere', 'near_start', 'near_exit', 'far', 'centre', 'guarded']).default('anywhere') })).max(6).default([]),
  terrain: z.array(z.object({ terrain: Id, density: z.number().min(0).max(0.3).default(0.03) })).max(6).default([]),
  /** what moving on is called here: "Stairs down", "Board the 6:15 train". */
  transitionName: z.string().max(60),
  transitionModel: ModelSpec.optional(),
  /** transition is locked until this is true (e.g. has key). */
  transitionRequires: Condition.optional(),
  /** notes for the GM about this area. */
  gmNotes: z.string().max(400).default(''),
  /** what is drawn beyond the map / in void tiles (M2). Default: plain sky/ambient colour. */
  backdrop: z
    .object({
      style: z.enum(['color', 'gradient', 'starfield', 'clouds', 'abyss', 'aurora', 'grid', 'noise']).default('color'),
      color: Color,
      color2: Color.optional(),
      /** 0..1 how busy/animated */
      intensity: z.number().min(0).max(1).default(0.5),
    })
    .optional(),
  music: z.enum(['explore', 'tense', 'calm', 'eerie', 'boss', 'upbeat']).default('explore'),
});
export type AreaPlan = z.infer<typeof AreaPlan>;

// ---------------------------------------------------------------------------
// Rule variants
// ---------------------------------------------------------------------------

export const RuleVariant = z.object({
  id: Id,
  name: z.string().max(40),
  /** player-facing explanation. */
  description: z.string().max(250),
  /** global triggers that run on the player (e.g. on_turn drain, on_kill corruption). */
  playerTriggers: z.array(Trigger).max(3).default([]),
  /** engine switches. */
  switches: z
    .object({
      durability: z.boolean().optional(),
      noNaturalHpRegen: z.boolean().optional(),
      /** all consumables start unknown */
      allConsumablesUnknown: z.boolean().optional(),
      /** enemies drop nothing */
      noLoot: z.boolean().optional(),
      /** sight radius multiplier */
      darkness: z.number().min(0.3).max(1).optional(),
      /** killing is penalised by this counter; GM may react */
      violenceCounter: Id.optional(),
      /** hunger-like: resource id drained each turn handled via CustomResource.perTurn */
      permadeathMercy: z.boolean().optional(),
    })
    .default({}),
});
export type RuleVariant = z.infer<typeof RuleVariant>;

// ---------------------------------------------------------------------------
// Vocabulary, GM, audio, meta
// ---------------------------------------------------------------------------

const StatName = z.object({ name: z.string().max(20), abbr: z.string().min(1).max(4), description: z.string().max(120) });

export const Vocabulary = z.object({
  stats: z.object({ str: StatName, dex: StatName, int: StatName, hp: StatName, mp: StatName, ac: StatName }),
  /** "attack" button / log verb: "Attack", "Put-down", "Interrogate". */
  conflict: z.string().max(20).default('Attack'),
  /** what defeated actors are: "slain", "humiliated", "arrested". */
  defeated: z.string().max(20).default('defeated'),
  xp: z.string().max(20).default('XP'),
  levelUp: z.string().max(30).default('Level up'),
  currency: z.string().max(20).default('coins'),
  /** death / loss screen headline */
  lossTitle: z.string().max(60).default('You have fallen'),
  winTitle: z.string().max(60).default('Victory'),
  /** name for areas: "Floor", "Day", "Deck", "District". */
  area: z.string().max(20).default('Area'),
});
export type Vocabulary = z.infer<typeof Vocabulary>;

export const GoalSpec = z.object({
  summary: z.string().max(200),
  /** win condition, checked every turn */
  win: Condition,
  /** optional extra loss condition besides death */
  lose: Condition.optional(),
  winText: z.string().max(500),
  /** the losing ending when the run is lost by goal.lose or a fatal resource (and by death when deathText is absent) */
  lossText: z.string().max(500),
  /**
   * The losing ending when the player is defeated (hp reaches 0). Optional, falls back to
   * lossText; worlds with goal.lose should give both, since the two endings usually differ.
   */
  deathText: z.string().max(500).optional(),
  /**
   * Player-facing names for the flags and counters the goal and locks use, keyed by their id
   * ({"soknad-stemplet": "Søknaden er stemplet"}); the goal tracker shows these instead of the ids.
   */
  labels: z.record(Id, z.string().min(1).max(60)).optional(),
});
export type GoalSpec = z.infer<typeof GoalSpec>;

export const GmSpec = z.object({
  persona: z.string().max(300),
  voice: z.string().max(200),
  /** themes and threads the GM should weave in. */
  threads: z.array(z.string().max(160)).max(5).default([]),
  /** canned narration used offline / as fallback, per moment. */
  fallback: z.object({
    intro: z.string().max(600),
    areaEnter: z.array(z.string().max(300)).min(1).max(6),
    lowHp: z.array(z.string().max(200)).max(4).default([]),
    events: z.array(z.string().max(200)).max(6).default([]),
  }),
});
export type GmSpec = z.infer<typeof GmSpec>;

export const AudioSpec = z.object({
  mood: z.string().max(200),
  /** generative synth knobs */
  synth: z.object({
    key: z.enum(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']).default('A'),
    scale: z.enum(['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'pentatonic', 'blues', 'whole_tone', 'chromatic']).default('minor'),
    tempo: z.number().int().min(40).max(180).default(80),
    timbre: z.enum(['pad', 'pluck', 'bell', 'organ', 'string', 'chip', 'noise', 'brass']).default('pad'),
    drone: z.boolean().default(true),
    percussion: z.enum(['none', 'soft', 'tribal', 'electronic', 'clockwork', 'heartbeat']).default('none'),
    brightness: z.number().min(0).max(1).default(0.4),
  }),
  /** search terms for an external music source (SoundCloud etc.) */
  searchTerms: z.array(z.string().max(60)).max(5).default([]),
  /** suggested playlist / artists the player can look up */
  suggestions: z.array(z.string().max(100)).max(5).default([]),
});
export type AudioSpec = z.infer<typeof AudioSpec>;

export const WorldMeta = z.object({
  title: z.string().max(60),
  tagline: z.string().max(140),
  genre: z.string().max(40),
  tags: z.array(z.string().max(24)).max(8),
  tone: z.string().max(60),
  era: z.string().max(60).optional(),
  premise: z.string().max(800),
  /** the player prompt that produced this world (empty = surprise). */
  prompt: z.string().max(500).default(''),
  /** whether conflict is mostly non-violent (social, investigative…) */
  nonViolent: z.boolean().default(false),
  /**
   * BCP-47 language of all player-facing text in this world (names, descriptions, dialogue, GM text),
   * e.g. "en", "nb". Ids stay ASCII. See DESIGN §7b.
   */
  language: z.string().min(2).max(12).default('en'),
});
export type WorldMeta = z.infer<typeof WorldMeta>;

export const Palette = z.object({
  primary: Color,
  secondary: Color,
  accent: Color,
  danger: Color,
  ui: Color,
  text: Color,
});

// ---------------------------------------------------------------------------
// The World Spec
// ---------------------------------------------------------------------------

export const WorldSpec = z.object({
  specVersion: z.literal(1),
  meta: WorldMeta,
  vocabulary: Vocabulary,
  palette: Palette,
  damageTypes: z.array(DamageType).min(1).max(8),
  statuses: z.array(StatusDef).max(12).default([]),
  resources: z.array(CustomResource).max(2).default([]),
  rules: z.array(RuleVariant).max(3).default([]),
  /** non-combat verbs enabled in this world */
  verbs: z
    .object({
      talk: z.boolean().default(true),
      sneak: z.boolean().default(false),
      search: z.boolean().default(true),
      persuade: z.boolean().default(false),
    })
    .default({ talk: true, sneak: false, search: true, persuade: false }),
  player: PlayerSpec,
  actors: z.array(ActorDef).min(4).max(28),
  items: z.array(ItemDef).min(8).max(32),
  terrains: z.array(TerrainDef).max(10).default([]),
  /** appearance pools for unknown items: { "flask": ["murky green flask", …] } */
  unknownAppearances: z
    .record(Id, z.array(z.object({ label: z.string().max(40), color: Color })).min(1).max(16))
    .default({}),
  areas: z.array(AreaPlan).min(2).max(6),
  goal: GoalSpec,
  gm: GmSpec,
  audio: AudioSpec,
});
export type WorldSpec = z.infer<typeof WorldSpec>;
/** input type (before defaults are applied) — what an LLM writes. */
export type WorldSpecInput = z.input<typeof WorldSpec>;
