/**
 * Difficulty (DESIGN §Difficulty): one profile per band. The engine applies it to
 *   - hostile actors: hp when they are created / transform, and the damage they deal to the
 *     player's side (combat.dealDamage)
 *   - the player's natural hp regeneration interval (turn.ts)
 *   - the harm a GM rule may add or take away (gm.ts add_rule / remove_rule, see rules.ts)
 * Saves keep the band in GameState.difficulty; states without one play as 'normal'.
 */
import { Difficulty } from '../schema/gm';
import type { GameState } from './types';

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
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  gentle: { hostileHp: 0.8, hostileDamage: 0.8, regenEvery: 0.75, ruleHarm: 1, ruleHarmTotal: 1 },
  normal: { hostileHp: 1, hostileDamage: 1, regenEvery: 1, ruleHarm: 6, ruleHarmTotal: 10 },
  hard: { hostileHp: 1.15, hostileDamage: 1.15, regenEvery: 1.25, ruleHarm: 12, ruleHarmTotal: 20 },
  brutal: { hostileHp: 1.3, hostileDamage: 1.3, regenEvery: 1.5, ruleHarm: 20, ruleHarmTotal: 35 },
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

/** hostile hp for a def's base hp under the state's difficulty */
export function scaledHostileHp(s: Pick<GameState, 'difficulty'>, hp: number): number {
  const f = profileOf(s).hostileHp;
  return f === 1 ? hp : Math.max(1, Math.round(hp * f));
}

/** the natural hp regeneration interval (0 = none) */
export function regenInterval(s: Pick<GameState, 'difficulty'>, every: number): number {
  if (every <= 0) return 0;
  const f = profileOf(s).regenEvery;
  return f === 1 ? every : Math.max(1, Math.round(every * f));
}
