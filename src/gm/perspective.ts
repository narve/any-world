/**
 * The client plays its own player id (MP3 design §1.3). The engine answers per player
 * (EngineEnv.playerId), but every lead read in the client (view.ts, travel.ts, guide.ts, the
 * renderer, audio cues) goes through party[0]. Instead of threading a pid through all of them, a
 * room session shows a perspective: the same state with that player first in party order.
 * Moved here from src/client/room (MP4 design §1.4): the room's GM reads every lead-only check,
 * prompt and dry run through the perspective of the player a moment is about.
 */
import type { GameState, PlayerId } from '../engine/types';

const memo = new WeakMap<GameState, Map<PlayerId, GameState>>();

/**
 * The same state with `pid` first in party order: every lead read (view, fog, compass, hints,
 * persuade odds, legal actions, renderer) then answers for `pid`. Read-only: never stepped, hashed
 * or sent. Memoised per (state, pid), so identity checks in the renderer still hold. A pid already
 * first (a party of one included), or one not in the party (left the map), gives `state` itself.
 */
export function perspective(state: GameState, pid: PlayerId): GameState {
  const i = state.party.indexOf(pid);
  if (i <= 0) return state;
  let m = memo.get(state);
  if (!m) memo.set(state, (m = new Map()));
  let v = m.get(pid);
  if (!v) {
    v = { ...state, party: [pid, ...state.party.slice(0, i), ...state.party.slice(i + 1)] };
    m.set(pid, v);
  }
  return v;
}
