/**
 * Turns the engine's short refusal reasons into messages that say why and what to do, using the
 * world's own status names and vocabulary (issues/M1-toast-pileup.md). The engine's reasons are
 * deliberately terse ("you cannot move"); the player needs "Lassoed (1 turn left): you cannot move —
 * wait (.) to let it pass". DOM-free.
 */
import type { GameState, PlayerAction } from '../engine/types';
import type { StatusDef, WorldSpec } from '../schema/world';

type Flag = StatusDef['flags'][number];

interface Holding {
  name: string;
  turnsLeft: number;
}

/** the player's statuses that carry `flag`, longest-lasting first */
export function statusesWithFlag(world: WorldSpec, state: GameState, flag: Flag): Holding[] {
  const p = state.area.actors.find((a) => a.id === state.player.actorId);
  if (!p) return [];
  const out: Holding[] = [];
  for (const s of p.statuses) {
    const def = world.statuses.find((d) => d.id === s.id);
    if (def && def.flags.includes(flag)) out.push({ name: def.name, turnsLeft: s.turnsLeft });
  }
  return out.sort((a, b) => b.turnsLeft - a.turnsLeft);
}

function turns(n: number): string {
  return `${n} turn${n === 1 ? '' : 's'}`;
}

/** "Lassoed (1 turn left)" / "Lassoed and Pinned (3 turns left)" */
function describeHold(h: Holding[]): string {
  const names = [...new Set(h.map((x) => x.name))];
  const label = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const left = Math.max(1, h[0].turnsLeft);
  return `${label} (${turns(left)} left)`;
}

const WAIT_HINT = 'wait (.) to let it pass';

/**
 * The message to show for an engine `invalid` event caused by `action`. Returns the engine's
 * reason (capitalised) when there is nothing more specific to say.
 */
export function explainInvalid(world: WorldSpec, state: GameState, action: PlayerAction, reason: string): string {
  const fallback = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : reason;
  const mentions = (h: Holding[]) => h.some((x) => reason.toLowerCase().includes(x.name.toLowerCase()));

  if (action.type === 'move' && /move/i.test(reason)) {
    const rooted = statusesWithFlag(world, state, 'rooted');
    if (rooted.length && !mentions(rooted)) return `${describeHold(rooted)}: you cannot move — ${WAIT_HINT}.`;
  }
  if ((action.type === 'move' || action.type === 'attack' || action.type === 'use') && /afraid/i.test(reason)) {
    const afraid = statusesWithFlag(world, state, 'afraid');
    if (afraid.length && !mentions(afraid)) {
      // the conflict verb is a button label ("Draw on", "Comeback"), so it is quoted, not conjugated
      const verb = world.vocabulary.conflict || 'Attack';
      return `${describeHold(afraid)}: "${verb}" is out of the question — step away, or ${WAIT_HINT}.`;
    }
  }
  return fallback;
}
