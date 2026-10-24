/**
 * Which music mood should play (pure). Priority, highest first:
 *   1. the end of the run (won → upbeat, lost → eerie)
 *   2. the GM's last `mood` action in this area
 *   3. "danger": low health or a fight involving the player turns explore/calm/upbeat areas tense
 *      for a while (DANGER_BATCHES quiet batches after the last threat)
 *   4. the area's own `music` (AreaPlan.music)
 * Entering a new area clears 2 and 3.
 */
import type { GameEvent } from '../../engine/types';
import { isMood, type MusicMood } from './theory';

/** event batches (≈ player actions) without danger before the tension lifts */
export const DANGER_BATCHES = 12;

const RELAXED: ReadonlySet<MusicMood> = new Set(['explore', 'calm', 'upbeat']);

export class MoodDirector {
  private area: MusicMood = 'explore';
  private gm: MusicMood | null = null;
  private danger = 0;
  private final: MusicMood | null = null;

  constructor(private areaMoods: readonly (string | undefined)[] = []) {
    this.area = this.areaMood(0);
  }

  get current(): MusicMood {
    if (this.final) return this.final;
    if (this.gm) return this.gm;
    if (this.danger > 0 && RELAXED.has(this.area)) return 'tense';
    return this.area;
  }

  setAreas(areaMoods: readonly (string | undefined)[], index = 0): void {
    this.areaMoods = areaMoods;
    this.enterArea(index);
  }

  enterArea(index: number): void {
    this.area = this.areaMood(index);
    this.gm = null;
    this.danger = 0;
    this.final = null;
  }

  /** a GM 'mood' action */
  setGm(mood: MusicMood): void {
    this.gm = mood;
  }

  /** process one batch of engine events; returns the mood now wanted */
  onEvents(events: readonly GameEvent[], playerId?: string): MusicMood {
    let threat = false;
    for (const e of events) {
      if (e.type === 'area_entered') this.enterArea(e.index);
      else if (e.type === 'low_hp') threat = true;
      else if (e.type === 'attacked' && (!playerId || e.attackerId === playerId || e.targetId === playerId)) threat = true;
      else if (e.type === 'game_over') this.final = e.result === 'won' ? 'upbeat' : 'eerie';
    }
    if (threat) this.danger = DANGER_BATCHES;
    else if (this.danger > 0) this.danger--;
    return this.current;
  }

  private areaMood(index: number): MusicMood {
    const m = this.areaMoods[index];
    return isMood(m) ? m : 'explore';
  }
}

/** the last mood among a list of GM actions (nested offer_choice options are not applied yet) */
export function moodFromGmActions(actions: readonly unknown[]): MusicMood | null {
  let mood: MusicMood | null = null;
  for (const a of actions) {
    if (a && typeof a === 'object' && (a as { type?: unknown }).type === 'mood') {
      const m = (a as { music?: unknown }).music;
      if (isMood(m)) mood = m;
    }
  }
  return mood;
}
