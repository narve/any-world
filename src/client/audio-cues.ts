/**
 * What the audio should know after a change in a run (DESIGN §5b): the engine events (the audio
 * engine turns them into sound effects and danger moods), GM mood actions, and the musical
 * situation (explore, combat, boss, victory, death, with the area's own music mood) — the audio
 * engine cannot see who is on screen, so the boss situation is worked out here. Pure and
 * deterministic: GameSession builds an AudioUpdate after every state change and hands it to its
 * audio listener (main.ts → audio-bridge.ts → audio/index.ts). Nothing here plays sound, so a run
 * is identical with audio on, off or missing.
 */
import type { AreaPlan, WorldSpec } from '../schema/world';
import type { GameEvent, GameState } from '../engine/types';
import { visibleHostiles } from './travel';

export type AudioSituation = 'explore' | 'combat' | 'boss' | 'victory' | 'death';

export interface AudioCue {
  situation: AudioSituation;
  /** area index (a new area may get new music) */
  area: number;
  /** the area plan's music mood */
  music: AreaPlan['music'];
}

/** what the session hands its audio listener after every engine state change */
export interface AudioUpdate {
  /** the engine events of this change (sound effects and mood: audio/index.ts onEvents) */
  events: readonly GameEvent[];
  playerId: string;
  /** GM actions applied in this change (their `mood` actions steer the music) */
  gmActions?: readonly unknown[];
  cue: AudioCue;
}

/** how close (tiles) a visible hostile must be for the music to turn to combat */
export const COMBAT_RANGE = 6;

function situationOf(world: WorldSpec, state: GameState): AudioSituation {
  if (state.status === 'won') return 'victory';
  if (state.status === 'lost') return 'death';
  const visible = visibleHostiles(state);
  if (!visible.size) return 'explore';
  const uniques = new Set(world.actors.filter((d) => d.unique && !d.npc).map((d) => d.id));
  const player = state.area.actors.find((a) => a.id === state.player.actorId);
  let combat = false;
  for (const a of state.area.actors) {
    if (!visible.has(a.id)) continue;
    if (uniques.has(a.defId)) return 'boss';
    if (player && Math.max(Math.abs(a.pos.x - player.pos.x), Math.abs(a.pos.y - player.pos.y)) <= COMBAT_RANGE) combat = true;
  }
  return combat ? 'combat' : 'explore';
}

/** the audio situation for `state` */
export function audioCueFor(world: WorldSpec, state: GameState): AudioCue {
  const area = state.area.index;
  return { situation: situationOf(world, state), area, music: world.areas[area]?.music ?? 'explore' };
}
