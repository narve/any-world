/**
 * Turns the engine's short refusal reasons into messages that say why and what to do, using the
 * world's own status names and vocabulary (issues/M1-toast-pileup.md). The engine's reasons are
 * deliberately terse ("you cannot move"); the player needs "Lassoed (1 turn left): you cannot move —
 * wait (.) to let it pass". DOM-free.
 */
import type { GameState, PlayerAction } from '../engine/types';
import type { StatusDef, WorldSpec } from '../schema/world';
import { listJoin, t } from './i18n/index';
import { lockedReason } from './guide';
import { engineReason } from './i18n/engine-text';
import { leadPlayer } from '../engine/index';

type Flag = StatusDef['flags'][number];

interface Holding {
  name: string;
  turnsLeft: number;
}

/** the player's statuses that carry `flag`, longest-lasting first */
export function statusesWithFlag(world: WorldSpec, state: GameState, flag: Flag): Holding[] {
  const p = state.area.actors.find((a) => a.id === leadPlayer(state).actorId);
  if (!p) return [];
  const out: Holding[] = [];
  for (const s of p.statuses) {
    const def = world.statuses.find((d) => d.id === s.id);
    if (def && def.flags.includes(flag)) out.push({ name: def.name, turnsLeft: s.turnsLeft });
  }
  return out.sort((a, b) => b.turnsLeft - a.turnsLeft);
}

/** "Lassoed (1 turn left)" / "Lassoed and Pinned (3 turns left)" */
function describeHold(h: Holding[]): string {
  const names = [...new Set(h.map((x) => x.name))];
  return t('invalid.hold', { names: listJoin(names, 'and'), n: Math.max(1, h[0].turnsLeft) });
}

/**
 * The message to show for an engine `invalid` event caused by `action`. Returns the engine's
 * reason in the UI language (engineReason: catalog key, else capitalised) when there is nothing
 * more specific to say.
 */
export function explainInvalid(world: WorldSpec, state: GameState, action: PlayerAction, reason: string): string {
  const fallback = engineReason(reason);
  const mentions = (h: Holding[]) => h.some((x) => reason.toLowerCase().includes(x.name.toLowerCase()));

  if (action.type === 'move' && /move/i.test(reason)) {
    const rooted = statusesWithFlag(world, state, 'rooted');
    if (rooted.length && !mentions(rooted)) return t('invalid.rooted', { hold: describeHold(rooted) });
  }
  if ((action.type === 'move' || action.type === 'attack' || action.type === 'use') && /afraid/i.test(reason)) {
    const afraid = statusesWithFlag(world, state, 'afraid');
    if (afraid.length && !mentions(afraid)) {
      // the conflict verb is a button label ("Draw on", "Comeback"), so it is quoted, not conjugated
      const verb = world.vocabulary.conflict || t('vocab.conflict');
      return t('invalid.afraid', { hold: describeHold(afraid), verb });
    }
  }
  if (action.type === 'transition') {
    const plan = world.areas[state.area.index];
    const way = plan?.transitionName ?? t('help.takeExit');
    // a locked way on says what it needs, in plain words
    if (/locked$/i.test(reason)) {
      const needs = lockedReason(world, state);
      return needs ? t('invalid.exitLocked', { way, needs }) : t('ctx.exitLockedPlain', { way });
    }
    if (/way onward/i.test(reason)) return t('invalid.notAtExit', { way });
    if (/nowhere further/i.test(reason)) return t('invalid.lastArea');
  }
  return fallback;
}
