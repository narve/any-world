/**
 * A room's log (MP2 design §4): the room's state only ever moves through LogEntry values, applied in
 * order with applyEntry. The server applies an entry, appends it to its log, then broadcasts it;
 * clients and a restart replay apply the same entries with the same function (lockstep). An entry
 * is data: GM entries carry the director's actions, so nobody but the server runs the director.
 */
import type { WorldSpec } from '../schema/world';
import type { GameEvent, GameState, TurnOutcome } from '../engine/types';
import { addPlayer, applyGmActions, leaveMap, returnToMap, setAway, stepTurn } from '../engine/index';
import type { LogEntry } from './protocol';

export type { LogEntry, LogEntryBody, LogEntryKind } from './protocol';

export interface Applied {
  state: GameState;
  events: GameEvent[];
  /** a turn entry's action outcomes (refusals included); empty for the other kinds */
  outcomes: TurnOutcome[];
}

/**
 * Applies one entry to `state` (never mutated) with the world passed explicitly, so the engine
 * registry is not needed:
 *  - turn: stepTurn(inputs, { advance })
 *  - gm: applyGmActions(actions) for `pid` (absent, or no longer on the map: the lead)
 *  - join: addPlayer({ name, near }); throws when the engine gives another player id than the entry's
 *  - away / back: setAway
 *  - leave: leaveMap; return: returnToMap({ near })
 * Engine refusals that throw (leaveMap of the last member…) propagate: the server checks first and
 * never appends such an entry, so on a client or a replay a throw means a desync or a bug.
 */
export function applyEntry(world: WorldSpec, state: GameState, e: LogEntry): Applied {
  const env = { world };
  switch (e.k) {
    case 'turn': {
      const r = stepTurn(state, e.inputs, { ...env, advance: e.advance });
      return { state: r.state, events: r.events, outcomes: r.outcomes };
    }
    case 'gm': {
      const pid = e.pid !== undefined && state.party.includes(e.pid) ? e.pid : undefined;
      const r = applyGmActions(state, e.actions, pid ? { ...env, playerId: pid } : env);
      return { state: r.state, events: r.events, outcomes: [] };
    }
    case 'join': {
      const r = addPlayer(state, { name: e.name, near: e.near }, env);
      if (r.playerId !== e.pid) throw new Error(`join entry ${e.n}: the engine made ${r.playerId}, the entry says ${e.pid}`);
      return { state: r.state, events: [], outcomes: [] };
    }
    case 'away':
    case 'back': {
      const r = setAway(state, e.pid, e.k === 'away', env);
      return { state: r.state, events: r.events, outcomes: [] };
    }
    case 'leave': {
      const r = leaveMap(state, e.pid, env);
      return { state: r.state, events: r.events, outcomes: [] };
    }
    case 'return': {
      const r = returnToMap(state, e.pid, { near: e.near }, env);
      return { state: r.state, events: r.events, outcomes: [] };
    }
  }
}

/** applies entries in order (a restart replay, or a client catching up after a reconnect) */
export function applyEntries(world: WorldSpec, state: GameState, entries: readonly LogEntry[]): GameState {
  let s = state;
  for (const e of entries) s = applyEntry(world, s, e).state;
  return s;
}

/** true when the entry changed area (the room snapshots, holds the clock and clears pending inputs) */
export function changedArea(before: GameState, after: GameState): boolean {
  return before.area.index !== after.area.index;
}
