/**
 * The turn clock (MP2 design §4), as a pure function of what the room knows: when the next party
 * turn resolves, and when the room must look again because the set of active players changes on
 * its own (idle, typing expiry, away timers, the end of an area hold). The room keeps one timer for
 * the earlier of the two and calls this again after every message, entry and timer.
 */
import type { GameState, PlayerId } from '../../src/engine/types';
import type { Intent } from '../../src/net/protocol';

export interface PendingInput {
  intent: Intent;
  /** when it arrived (or the resolve that carried it over) */
  at: number;
  /** the player is engine-ready (readyPlayers): its turn action can resolve now */
  ready: boolean;
}

export interface ClockView {
  /** players a turn waits for: engine-ready seats that are connected, playing, not typing, not in a dialogue, not idle */
  active: readonly PlayerId[];
  /** engine readyPlayers */
  ready: readonly PlayerId[];
  /** each player's turn action for the next turn (latest wins) */
  pending: ReadonlyMap<PlayerId, PendingInput>;
  /** when the first pending input arrived (not before the end of an area hold); null = none */
  firstAt: number | null;
  /** when the last turn resolved (taken after the step, so a slow step shortens no deadline) */
  lastResolveAt: number;
  /** room option (1–5 s) */
  deadlineMs: number;
  travelMs: number;
  countdownTurnMs: number;
  /** calm turns: how long a pending input waits for the active players who have not acted */
  calmGraceMs: number;
  /** no living hostile is in view of a standing player on the map (hostileInView is false) */
  calm: boolean;
  /** rule 4a is on (RoomTiming.calmFlow; tests of the waiting UI turn it off) */
  calmFlow: boolean;
  /** a party member is down (getting up by themselves takes turns) and someone else stands */
  downWaiting: boolean;
  /** state.area.exitCountdown is set */
  countdown: boolean;
  /** the area was just entered: no deadline starts and nothing resolves before this */
  areaHoldUntil: number | null;
  anyConnected: boolean;
  /** times at which the active set changes without a message (idle, typing, away, hold, clock throttle) */
  wakes: readonly number[];
}

export interface ClockDecision {
  /** the next turn: at `at` (≤ now = at once), with stepTurn's `advance` */
  resolve: { at: number; advance: boolean } | null;
  /** the earliest wake after `now`, or null */
  wakeAt: number | null;
}

/**
 * Rules, in order:
 *  0. nobody connected: nothing resolves and no wakes (an empty room sleeps, countdown included);
 *  1. exit countdown: a turn every countdownTurnMs after the last one, advance: true;
 *  2. area hold: nothing before it ends;
 *  3. everyone active has acted (true for an empty active set) and something is pending:
 *     a ready player's input: now when one intent is `decide`, else at the travel cadence, advance:
 *     false; no pending input from a ready player: at the travel cadence with advance: true (the
 *     world runs until the slow ones are ready);
 *  4. something is pending and someone active has not acted:
 *     a. calm (no hostile in view of a standing player): flow over fairness, the ones who have not
 *        acted wait that turn as on a deadline: only travel or wait pending at the travel cadence,
 *        else firstAt + calmGraceMs (never earlier than the travel cadence), advance: true;
 *     b. otherwise firstAt + deadlineMs, advance: true;
 *  5. nothing pending: no resolve (while nobody acts the world does not move), except
 *  6. someone is down and it is calm: a turn every countdownTurnMs with advance: true, so the
 *     self-revive counts down while the teammates read, chat or look away (MP5: nobody waits).
 *     It stops once nobody is down or a hostile comes into view, but these turns also move hostiles
 *     out of view and tick world clocks and hunger while nobody is at the controls (open, with the
 *     owner's shared-clock decision: watch for it in the real-people session).
 */
export function nextResolve(v: ClockView, now: number): ClockDecision {
  if (!v.anyConnected) return { resolve: null, wakeAt: null };
  let wakeAt: number | null = null;
  for (const w of v.wakes) if (w > now && (wakeAt === null || w < wakeAt)) wakeAt = w;
  if (v.areaHoldUntil !== null && v.areaHoldUntil > now && (wakeAt === null || v.areaHoldUntil < wakeAt)) wakeAt = v.areaHoldUntil;

  if (v.countdown) return { resolve: { at: v.lastResolveAt + v.countdownTurnMs, advance: true }, wakeAt };
  if (v.areaHoldUntil !== null && v.areaHoldUntil > now) return { resolve: null, wakeAt };
  if (v.pending.size === 0) {
    if (v.downWaiting && v.calm) return { resolve: { at: v.lastResolveAt + v.countdownTurnMs, advance: true }, wakeAt };
    return { resolve: null, wakeAt };
  }

  const allActed = v.active.every((id) => v.pending.has(id));
  if (allActed) {
    const fromReady = [...v.pending.values()].filter((p) => p.ready);
    if (fromReady.length === 0) return { resolve: { at: v.lastResolveAt + v.travelMs, advance: true }, wakeAt };
    if (fromReady.some((p) => p.intent === 'decide')) return { resolve: { at: now, advance: false }, wakeAt };
    return { resolve: { at: v.lastResolveAt + v.travelMs, advance: false }, wakeAt };
  }
  const start = Math.max(v.firstAt ?? now, v.areaHoldUntil ?? -Infinity);
  if (v.calm && v.calmFlow) {
    const cadence = v.lastResolveAt + v.travelMs;
    const onlyFlow = [...v.pending.values()].every((p) => p.intent !== 'decide');
    return { resolve: { at: onlyFlow ? cadence : Math.max(cadence, start + v.calmGraceMs), advance: true }, wakeAt };
  }
  return { resolve: { at: start + v.deadlineMs, advance: true }, wakeAt };
}

/**
 * Whether a living hostile (not an ally) stands on a tile some standing party member on the map
 * sees now (that member's fog). Down players' eyes do not count: they cannot act on it.
 */
export function hostileInView(state: GameState): boolean {
  const w = state.area.map.width;
  const eyes = state.party.map((id) => state.players[id]).filter((ps) => ps && !ps.down && !ps.left);
  if (!eyes.length) return false;
  const mine = new Set(eyes.map((ps) => ps!.actorId));
  for (const a of state.area.actors) {
    if (a.hp <= 0 || a.faction !== 'hostile' || a.allyOf || mine.has(a.id)) continue;
    const i = a.pos.y * w + a.pos.x;
    if (eyes.some((ps) => ps!.seen[i] === 2)) return true;
  }
  return false;
}
