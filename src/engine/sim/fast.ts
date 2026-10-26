/**
 * In-place step for simulations. The public `step()` deep-clones the whole GameState on every call
 * (structuredClone, ~65% of simulation time); a simulator that owns its state can skip that.
 *
 * fastStep mirrors src/engine/index.ts step() exactly, minus the clone: it MUTATES `state`.
 * tests/sim/fast.test.ts plays long random/bot games through both and requires identical
 * serialized states, so any drift from the real step() fails the tests.
 */
import type { WorldSpec } from '../../schema/world';
import type { GameEvent, GameState, MapGenerator, PlayerAction, StepResult } from '../types';
import { type Ctx, indexWorld, playerActor } from '../ctx';
import { rngFromState } from '../rng';
import { generateArea } from '../mapgen/index';
import { doPlayerAction } from '../actions';
import { ACT_COST, checkEnd, runWorld } from '../turn';
import { checkQuests } from '../gm';
import { updateFov } from '../vision';

export function fastStep(state: GameState, action: PlayerAction, world: WorldSpec, mapGenerator?: MapGenerator): StepResult {
  if (state.status !== 'playing') return { state, events: [{ type: 'invalid', reason: 'the run is over' }], tookTurn: false };
  for (const id of state.party) {
    const ps = state.players[id];
    if (!(ps.seen instanceof Uint8Array)) ps.seen = Uint8Array.from(ps.seen as number[]);
  }
  const ctx: Ctx = { world, ix: indexWorld(world), s: state, pid: state.party[0], rng: rngFromState(state.rng), events: [], mapGen: mapGenerator ?? generateArea, depth: 0 };
  const r = doPlayerAction(ctx, action);
  if (!r.ok) {
    const events: GameEvent[] = [{ type: 'invalid', reason: r.reason ?? 'not possible' }];
    return { state, events, tookTurn: false };
  }
  if (r.tookTurn) {
    const p = playerActor(ctx);
    p.energy -= r.cost ?? ACT_COST;
    runWorld(ctx);
  } else {
    checkQuests(ctx);
  }
  if (ctx.s.status === 'playing') checkEnd(ctx);
  updateFov(ctx);
  ctx.s.rng = ctx.rng.state();
  return { state: ctx.s, events: ctx.events, tookTurn: r.tookTurn };
}
