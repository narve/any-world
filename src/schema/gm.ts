/**
 * Game-master schemas: what the live GM (LLM) may return during play.
 * GM actions are a whitelist built from the same building blocks as the world spec,
 * and are budgeted by the engine (see GM_ACTION_COST).
 */
import { z } from 'zod';
import { Id, Effect, Condition, Color, RuleVariant } from './world';

const leafActions = [
  z.object({ type: z.literal('narrate'), text: z.string().max(600) }),
  z.object({ type: z.literal('say'), actorId: z.string().max(20), text: z.string().max(400) }),
  z.object({ type: z.literal('spawn'), actor: Id, count: z.number().int().min(1).max(3).default(1), near: z.enum(['player', 'random', 'exit']).default('random') }),
  z.object({ type: z.literal('give_item'), item: Id, count: z.number().int().min(1).max(3).default(1) }),
  z.object({ type: z.literal('place_item'), item: Id, near: z.enum(['player', 'random', 'exit']).default('random') }),
  z.object({ type: z.literal('effect'), target: z.enum(['player', 'nearest_enemy', 'all_visible_enemies']), effects: z.array(Effect).min(1).max(3) }),
  z.object({ type: z.literal('set_flag'), flag: Id, value: z.boolean().default(true) }),
  z.object({ type: z.literal('change_faction'), actorId: z.string().max(20), faction: z.enum(['hostile', 'neutral', 'friendly']) }),
  z.object({ type: z.literal('reveal_item'), item: Id, level: z.enum(['vague', 'clear']) }),
  z.object({
    type: z.literal('start_quest'),
    id: Id,
    title: z.string().max(60),
    description: z.string().max(300),
    complete: Condition,
    reward: z.array(z.object({ type: z.enum(['give_item', 'grant_xp', 'currency']), item: Id.optional(), amount: z.number().int().min(1).max(500).optional() })).max(3),
  }),
  z.object({ type: z.literal('trade'), actorId: z.string().max(20), items: z.array(z.object({ item: Id, price: z.number().int().min(0).max(9999) })).max(6) }),
  z.object({ type: z.literal('currency'), amount: z.number().int().min(-500).max(500) }),
  z.object({ type: z.literal('grant_xp'), amount: z.number().int().min(1).max(200) }),
  z.object({ type: z.literal('mood'), music: z.enum(['explore', 'tense', 'calm', 'eerie', 'boss', 'upbeat']), tint: Color.optional() }),
  /**
   * GM invents a new rule mid-run (M2). Engine enforces: max MAX_ACTIVE_RULES active, max one GM rule
   * per area, power impact vs difficulty (see engine/rules.ts). `reason` is the in-story announcement.
   */
  z.object({ type: z.literal('add_rule'), rule: RuleVariant, reason: z.string().max(300) }),
  z.object({ type: z.literal('remove_rule'), id: Id, reason: z.string().max(300) }),
] as const;

/** actions allowed inside offer_choice options (anything but offer_choice). */
export const GmLeafAction = z.discriminatedUnion('type', [...leafActions]);
export type GmLeafAction = z.infer<typeof GmLeafAction>;

export const GmAction = z.discriminatedUnion('type', [
  ...leafActions,
  z.object({
    type: z.literal('offer_choice'),
    prompt: z.string().max(400),
    options: z
      .array(
        z.object({
          label: z.string().max(80),
          /** actions applied if chosen (no nested offer_choice) */
          actions: z.array(GmLeafAction).max(4),
        }),
      )
      .min(2)
      .max(3),
  }),
]);
export type GmAction = z.infer<typeof GmAction>;


/** budget cost per action type; the engine refuses actions beyond the area budget. */
export const GM_ACTION_COST: Record<GmAction['type'], number> = {
  narrate: 0,
  say: 0,
  mood: 0,
  set_flag: 0,
  reveal_item: 1,
  change_faction: 2,
  place_item: 2,
  give_item: 3,
  currency: 1,
  grant_xp: 2,
  effect: 3,
  spawn: 3,
  start_quest: 2,
  offer_choice: 1,
  trade: 0,
  add_rule: 4,
  remove_rule: 2,
};
export const MAX_ACTIVE_RULES = 5;
export const MAX_GM_RULES_PER_AREA = 1;
export const GM_BUDGET_PER_AREA = 10;

/**
 * Difficulty of a run (start-screen slider, NewGameOptions.difficulty). The engine scales hostile
 * actors and natural regeneration by it and limits the harm of GM rules (engine/difficulty.ts).
 */
export const Difficulty = z.enum(['gentle', 'normal', 'hard', 'brutal']);
export type Difficulty = z.infer<typeof Difficulty>;

/** what the GM returns for any hook. */
export const GmResponse = z.object({
  actions: z.array(GmAction).max(6),
});
export type GmResponse = z.infer<typeof GmResponse>;

/**
 * A room GM's answer (MP4 design §1.4): a GmResponse that may name the party member its actions
 * are for (default: the player the moment is about). Room-only: single player's schema, doc and
 * prompts never mention `player`.
 */
export const RoomGmResponse = GmResponse.extend({
  player: z.string().max(8).optional(),
});
export type RoomGmResponse = z.infer<typeof RoomGmResponse>;

/** NPC dialogue turn: in-character reply + up to 3 player reply options + actions. */
export const DialogueResponse = z.object({
  reply: z.string().max(600),
  options: z.array(z.string().max(100)).max(3).default([]),
  actions: z.array(GmAction).max(3).default([]),
  /** conversation ended by the NPC */
  end: z.boolean().default(false),
});
export type DialogueResponse = z.infer<typeof DialogueResponse>;

/** the moments the GM is consulted. */
export const GmHook = z.enum([
  'intro',          // run starts
  'area_enter',     // new area
  'region_discovered',
  'low_hp',
  'boss_seen',
  'milestone',      // quest done, level up, unique defeated
  'idle',           // every ~60 turns without other hooks
  'death',          // epitaph
  'victory',
  'chat',           // rooms only (MP4): the players' chat addresses the GM; words only, never in single player
]);
export type GmHook = z.infer<typeof GmHook>;
