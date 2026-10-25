/**
 * Re-checks GM actions against the state they are APPLIED to (issues/M5-stale-gm-fiat.md).
 *
 * The GM runtime checks a model's answer (goal protection, "damage that could knock the player out",
 * an engine dry run) against the snapshot the request was made from. The answer can arrive seconds
 * later while play goes on, an answer can wait for an open choice to close (HOLD_TURNS), and an
 * offer_choice option runs only when the player picks it. Between the check and the application the
 * player may have lost hp or a goal actor may have walked into the area, so a "safe" action can decide
 * the run by fiat. Before applying, the client drops every action that, against the CURRENT state:
 *
 *  - fails the state-dependent goal check (stateGoalProblem: lethal player damage, harmful effects
 *    at enemies while a goal actor is here, change_faction on a goal actor, a hostile trade), or
 *  - would, in an engine dry run (cumulative, action by action), end the run or harm, remove,
 *    transform or turn a goal actor that is in the area.
 *
 * The world-only checks (goal writes, bounds, hook rules) do not depend on the state and were
 * already applied by the runtime, so they are not repeated here. Engine refusals (budget, missing
 * references) are left to the real application, which skips them itself. Pure; no DOM.
 */
import type { WorldSpec } from '../schema/world';
import type { GmAction } from '../schema/gm';
import type { ActorInstance, GameState } from '../engine/types';
import { applyGmActions } from '../engine/index';
import { goalRefs, stateGoalProblem } from '../llm/gm-checks';

export interface RecheckResult {
  /** the actions that are still safe to apply, in their original order */
  actions: GmAction[];
  /** readable reasons for the dropped ones (console / debugging) */
  dropped: { index: number; type: GmAction['type']; reason: string }[];
}

function goalActorsHere(world: WorldSpec, state: GameState): ActorInstance[] {
  const refs = goalRefs(world);
  if (!refs.actors.size) return [];
  return state.area.actors.filter((x) => x.hp > 0 && x.id !== state.player.actorId && refs.actors.has(x.defId));
}

function outcomeProblem(world: WorldSpec, before: GameState, after: GameState): string | null {
  if (before.status === 'playing' && after.status !== 'playing') return `it would end the run (${after.status})`;
  for (const g of goalActorsHere(world, before)) {
    const now = after.area.actors.find((x) => x.id === g.id);
    if (!now || now.hp <= 0 || now.defId !== g.defId || now.hp < g.hp || now.faction !== g.faction) return `it would harm goal actor "${g.defId}"`;
  }
  return null;
}

/** the GM actions that are still safe against `state` (see the module comment) */
export function recheckGmActions(world: WorldSpec, state: GameState, actions: readonly GmAction[]): RecheckResult {
  const out: RecheckResult = { actions: [], dropped: [] };
  if (state.status !== 'playing') return { actions: [...actions], dropped: [] };
  let s = state;
  actions.forEach((a, index) => {
    let reason: string | null = null;
    try {
      reason = stateGoalProblem(world, s, a);
    } catch (e) {
      reason = `check failed (${e instanceof Error ? e.message : String(e)})`;
    }
    if (!reason) {
      try {
        const r = applyGmActions(s, [a], { world });
        if (!(r.gmSkipped ?? []).length) {
          reason = outcomeProblem(world, s, r.state);
          if (!reason) s = r.state;
        }
      } catch (e) {
        reason = `the engine could not apply it (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    if (reason) out.dropped.push({ index, type: a.type, reason });
    else out.actions.push(a);
  });
  return out;
}

/**
 * A copy of `state` whose open gm_offer option `index` keeps only the actions that are still safe
 * (an offer is checked when it is made but runs when the player picks it). Returns `state` itself
 * when nothing needs to change.
 */
export function recheckOfferOption(world: WorldSpec, state: GameState, index: number): { state: GameState; dropped: RecheckResult['dropped'] } {
  const pc = state.pendingChoice;
  const opt = pc?.kind === 'gm_offer' ? pc.options[index] : undefined;
  if (!pc || !opt || !opt.actions.length) return { state, dropped: [] };
  // the dry run sees the state as it will be once the choice is resolved (no open choice)
  const probe: GameState = { ...state, pendingChoice: null };
  const r = recheckGmActions(world, probe, opt.actions);
  if (!r.dropped.length) return { state, dropped: [] };
  const options = pc.options.map((o, i) => (i === index ? { ...o, actions: r.actions } : o));
  return { state: { ...state, pendingChoice: { ...pc, options } }, dropped: r.dropped };
}
