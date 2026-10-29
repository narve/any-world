/**
 * The NPC voice in rooms (MP4 design §4.3), the rule both sides share: which turn entry is a new
 * conversation turn for a player, so the server asks the voice for it and the player's page knows
 * which `npc` line belongs to the conversation on screen. Pure.
 *
 * A moment is a turn entry in which the player's own input went through (its first action ok) and
 * left a dialogue open: a conversation opened (or switched to another NPC), or a reply that was not a
 * buy or sell (a trade keeps the NPC's line, as in single player). The entry's n names the moment.
 */
import type { GameState, PlayerAction, PlayerId, TurnOutcome } from '../engine/types';

/** the voice line's length on the wire (protocol `npc`) */
export const VOICE_TEXT_MAX = 600;

export interface VoiceMoment {
  /** the NPC's actor id */
  npcId: string;
  kind: 'open' | 'reply';
  /** a reply: the option the player chose (the engine's label) */
  playerLine?: string;
  /** a reply: the NPC's line the player answered (the engine's prompt) */
  answered?: string;
}

export function voiceMoment(before: GameState, after: GameState, pid: PlayerId, actions: readonly PlayerAction[] | undefined, outcomes: readonly TurnOutcome[]): VoiceMoment | null {
  const pc = after.players[pid]?.pendingChoice;
  if (!actions?.length || pc?.kind !== 'dialogue' || !pc.speakerId) return null;
  if (!outcomes.find((o) => o.playerId === pid)?.ok) return null;
  const was = before.players[pid]?.pendingChoice;
  const choose = actions.find((a): a is Extract<PlayerAction, { type: 'choose_option' }> => a.type === 'choose_option');
  if (was?.kind === 'dialogue' && choose) {
    const opt = was.options[choose.index];
    if (!opt || opt.tag === 'buy' || opt.tag === 'sell') return null;
    return { npcId: pc.speakerId, kind: 'reply', playerLine: opt.label, answered: was.prompt };
  }
  if (was?.kind === 'dialogue' && was.speakerId === pc.speakerId) return null;
  return { npcId: pc.speakerId, kind: 'open' };
}
