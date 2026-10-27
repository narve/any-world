/**
 * Difficulty (DESIGN §Difficulty): one profile per band. The engine applies it to
 *   - hostile actors: hp when they are created / transform (times UNIQUE_HOSTILE_HP for uniques),
 *     and the damage they deal to the
 *     player's side (combat.dealDamage)
 *   - the player's natural hp regeneration interval (turn.ts)
 *   - the harm a GM rule may add or take away (gm.ts add_rule / remove_rule, see rules.ts)
 *   - whether the first defeat of a run is a second chance (combat.killPlayer), and in a party of
 *     two or more whether every player has one (partySecondChance)
 * Party scaling (PARTY_SCALING, MP1 B3) sits on top of the band for parties of two or more: map
 * size, hostile numbers and hp, items, GM budget and the actor cap grow with the party.
 * Saves keep the band in GameState.difficulty; states without one play as 'normal'.
 */
import { Difficulty } from '../schema/gm';
import type { AreaState, GameState } from './types';

export { Difficulty };

export const DIFFICULTIES: readonly Difficulty[] = Difficulty.options;

export interface DifficultyProfile {
  /** multiplier on hostile hp (rounded, at least 1) */
  hostileHp: number;
  /** multiplier on damage that hostile actors deal to the player and the player's allies */
  hostileDamage: number;
  /** multiplier on WorldSpec.player.hpRegenEvery (larger = slower natural healing) */
  regenEvery: number;
  /**
   * Most harm (estimateRuleImpact hpPer100) one GM rule change may add: adding a rule whose net
   * impact is above it, or removing a helpful rule worth more than it, is refused. On gentle a
   * harmful rule needs a counterweight in the same rule (its net impact must stay about neutral).
   */
  ruleHarm: number;
  /** most net harm all GM-added rules together may have */
  ruleHarmTotal: number;
  /**
   * The first time the player would be defeated they get up again at half health, as a world's
   * permadeathMercy rule does (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §1.5: Gentle did not feel
   * gentle; every death came with a tool or escape unused).
   */
  secondChance: boolean;
  /**
   * In a party of two or more, each player's first fall is a second chance (owner decision,
   * MULTIPLAYER-PLAN §6: Gentle and Normal, not Hard and Brutal). A party of one keeps
   * `secondChance` alone, so single player is unchanged.
   */
  partySecondChance: boolean;
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  gentle: { hostileHp: 0.8, hostileDamage: 0.8, regenEvery: 0.75, ruleHarm: 1, ruleHarmTotal: 1, secondChance: true, partySecondChance: true },
  normal: { hostileHp: 1, hostileDamage: 1, regenEvery: 1, ruleHarm: 6, ruleHarmTotal: 10, secondChance: false, partySecondChance: true },
  hard: { hostileHp: 1.15, hostileDamage: 1.15, regenEvery: 1.25, ruleHarm: 12, ruleHarmTotal: 20, secondChance: false, partySecondChance: false },
  brutal: { hostileHp: 1.3, hostileDamage: 1.3, regenEvery: 1.5, ruleHarm: 20, ruleHarmTotal: 35, secondChance: false, partySecondChance: false },
};

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);
}

/** the band of a state ('normal' for states from before difficulty existed) */
export function difficultyOf(s: Pick<GameState, 'difficulty'>): Difficulty {
  return isDifficulty(s.difficulty) ? s.difficulty : 'normal';
}

export function profileOf(s: Pick<GameState, 'difficulty'>): DifficultyProfile {
  return DIFFICULTY_PROFILES[difficultyOf(s)];
}

/**
 * Whether the band gives every player a second chance (before any world rule): Gentle always, and
 * Normal too in a party of two or more (partySecondChance).
 */
export function bandSecondChance(s: Pick<GameState, 'difficulty' | 'party'>): boolean {
  const pr = profileOf(s);
  return pr.secondChance || (s.party.length >= 2 && pr.partySecondChance);
}

/**
 * Extra hp of unique hostiles (bosses) on every band, multiplied with the band's hostileHp: the
 * player's 90 % hit chance (combat PLAYER_HIT_CHANCE) about halved the final bosses' static risk.
 * balance/static.ts uses the same factor (uniqueHp).
 */
export const UNIQUE_HOSTILE_HP = 1.25;

/** a unique hostile's base hp before difficulty (balance/static.ts) */
export function uniqueHp(hp: number): number {
  return Math.max(1, Math.round(hp * UNIQUE_HOSTILE_HP));
}

/**
 * hostile hp for a def's base hp under the state's difficulty and the party size the area was
 * built for (AreaState.partySize); NPCs (def.npc) keep their hp on every band and party size, but
 * a unique NPC still gets the boss factor
 */
export function scaledHostileHp(
  s: Pick<GameState, 'difficulty'> & { area?: Pick<AreaState, 'partySize'> },
  def: { stats: { hp: number }; unique?: boolean; npc?: unknown },
): number {
  let f = (def.npc ? 1 : profileOf(s).hostileHp) * (def.unique ? UNIQUE_HOSTILE_HP : 1);
  const n = s.area?.partySize ?? 1;
  if (n > 1 && !def.npc) f *= partyFactor(n, def.unique ? PARTY_SCALING.uniqueHp : PARTY_SCALING.hostileHp);
  return f === 1 ? def.stats.hp : Math.max(1, Math.round(def.stats.hp * f));
}

/** most players in one party (MULTIPLAYER-PLAN §1: 8 by default, up to 12) */
export const MAX_PARTY_SIZE = 12;

/**
 * How an area grows with the party it is built for (docs/progress/MP1-DESIGN.md §6): each factor
 * k gives 1 + k·(n − 1) for n players. Applied only for n ≥ 2: a party of one skips the scaling
 * code entirely, so single-player maps, spawns and hp are unchanged.
 *
 * Tuned in MP1 B4 (docs/progress/MP1.md) from 2–4 player bot runs on all worlds. A party almost
 * never loses on Normal (everyone must be down at once), so the measure is how often a player
 * falls at least once: with hostiles ×(1 + 0.35·(n−1)) and hp ×(1 + 0.15·(n−1)) that share fell
 * from 14 % (2 players) to 8 % (4), larger parties being safer per player; at 0.65 / 0.3 it stays
 * about flat, 20–24 %, without longer runs.
 */
export const PARTY_SCALING = {
  /** map area (width and height each grow by the square root) */
  mapArea: 0.15,
  /** spawn-table minimums and maximums, and the extra spawns of the area size */
  hostileCount: 0.65,
  /** ordinary hostiles' hp */
  hostileHp: 0.3,
  /** bosses' hp (they face the whole party's focus fire) */
  uniqueHp: 0.5,
  /** plan.itemCount (packs are personal); placed items (keys, goal items) stay single */
  itemCount: 0.5,
  /** the GM's budget per area */
  gmBudget: 0.25,
  /** extra room in the per-area actor cap per extra player (absolute, not a factor) */
  actorCap: 10,
} as const;

/** 1 + k·(n − 1): the scale for a party of n */
export function partyFactor(n: number, k: number): number {
  return 1 + k * (Math.max(1, n) - 1);
}

/** a party size as the scaling uses it: a whole number in 1..MAX_PARTY_SIZE (1 for anything odd) */
export function clampPartySize(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARTY_SIZE, Math.round(n))) : 1;
}

/** `base` scaled for a party of n by factor k, rounded; `base` itself for a party of one */
export function partyScaled(base: number, n: number, k: number): number {
  return n > 1 ? Math.round(base * partyFactor(n, k)) : base;
}

/** the natural hp regeneration interval (0 = none) */
export function regenInterval(s: Pick<GameState, 'difficulty'>, every: number): number {
  if (every <= 0) return 0;
  const f = profileOf(s).regenEvery;
  return f === 1 ? every : Math.max(1, Math.round(every * f));
}
