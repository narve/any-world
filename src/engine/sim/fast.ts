/**
 * In-place stepping for simulations. The public `step()` / `stepTurn()` clone the whole GameState
 * on every call (structuredClone, ~65% of simulation time); a simulator that owns its state can
 * skip that.
 *
 * fastStep and fastStepTurn run the same party-turn core as the public API (engine/party.ts
 * runTurn), minus the clone: they MUTATE `state`. tests/sim/fast.test.ts plays long random/bot
 * games through both and requires identical serialized states, so any drift fails the tests.
 */
import type { WorldSpec } from '../../schema/world';
import type { EngineProfile } from '../ctx';
import type { GameState, MapGenerator, PlayerAction, StepResult, TurnInput, TurnOptions, TurnResult } from '../types';
import { type Ctx, indexWorld } from '../ctx';
import { rngFromState } from '../rng';
import { generateArea } from '../mapgen/index';
import { runTurn } from '../party';

export function fastStep(state: GameState, action: PlayerAction, world: WorldSpec, mapGenerator?: MapGenerator): StepResult {
  const r = fastStepTurn(state, [{ playerId: state.party[0], actions: [action] }], world, { mapGenerator });
  return { state: r.state, events: r.events, tookTurn: r.tookTurn };
}

/** stepTurn in place (MUTATES `state`) */
export function fastStepTurn(
  state: GameState,
  inputs: TurnInput[],
  world: WorldSpec,
  opts: TurnOptions & { mapGenerator?: MapGenerator; profile?: EngineProfile } = {},
): TurnResult {
  if (state.status !== 'playing') return { state, events: [{ type: 'invalid', reason: 'the run is over' }], tookTurn: false, outcomes: [], waited: [] };
  for (const id of state.party) {
    const ps = state.players[id];
    if (!(ps.seen instanceof Uint8Array)) ps.seen = Uint8Array.from(ps.seen as number[]);
  }
  const ctx: Ctx = {
    world,
    ix: indexWorld(world),
    s: state,
    pid: state.party[0],
    rng: rngFromState(state.rng),
    events: [],
    mapGen: opts.mapGenerator ?? generateArea,
    depth: 0,
    ...(opts.profile ? { profile: opts.profile } : {}),
  };
  const r = runTurn(ctx, inputs, opts.advance ? { advance: true } : {});
  return { state, events: ctx.events, tookTurn: r.tookTurn, outcomes: r.outcomes, waited: r.waited };
}
