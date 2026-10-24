/**
 * Scripted GM for simulations: feeds a fixed, world-derived sequence of GM actions through
 * applyGmActions so bot runs exercise the GM paths (spawn, offer_choice, add_rule/remove_rule,
 * gifts, effects) the live LLM game master would use. Pure: the plan depends only on the world,
 * the area index and the turn.
 */
import type { WorldSpec } from '../../schema/world';
import { RuleVariant } from '../../schema/world';
import type { GmAction } from '../../schema/gm';
import type { GameState } from '../types';
import { itemProfile } from './view';

/** id of the rule the scripted GM adds (and later removes) */
export const SIM_RULE_ID = 'sim-gm-rule';

function healingItem(world: WorldSpec): string | undefined {
  let best: string | undefined;
  let bestHeal = 0;
  for (const def of world.items) {
    const h = itemProfile(world, def).heal;
    if (h > bestHeal && def.useMode !== 'passive') {
      bestHeal = h;
      best = def.id;
    }
  }
  return best;
}

function areaHostile(world: WorldSpec, areaIndex: number): string | undefined {
  const plan = world.areas[areaIndex];
  const ids = plan?.actors.map((a) => a.actor) ?? [];
  // the weakest hostile of the spawn table (a GM spawn should add tension, not end the run)
  const defs = ids
    .map((id) => world.actors.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => !!a && a.faction === 'hostile' && !a.unique);
  defs.sort((a, b) => a.stats.hp - b.stats.hp);
  return defs[0]?.id;
}

/** a mild, helpful GM rule: a slow mending */
export function simRule(): RuleVariant {
  return RuleVariant.parse({
    id: SIM_RULE_ID,
    name: 'Second wind',
    description: 'Every 20 turns you recover a little.',
    playerTriggers: [
      {
        on: 'on_turn',
        every: 20,
        action: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false }, effects: [{ type: 'heal', amount: { base: 1 } }] },
      },
    ],
    switches: {},
  });
}

/**
 * GM actions for the moment the player first acts in `areaIndex` (keyed by area so a run gets
 * each batch once). Budget per area is 10 (see GM_BUDGET_PER_AREA); every batch stays within it.
 */
export function gmActionsForArea(world: WorldSpec, areaIndex: number): GmAction[] {
  const heal = healingItem(world);
  const hostile = areaHostile(world, areaIndex);
  const out: GmAction[] = [{ type: 'narrate', text: world.gm.fallback.areaEnter[areaIndex % world.gm.fallback.areaEnter.length] }];
  const offer = (): GmAction | null =>
    heal
      ? {
          type: 'offer_choice',
          prompt: 'A small mercy is offered.',
          options: [
            { label: 'Accept', actions: [{ type: 'give_item', item: heal, count: 1 }] },
            { label: 'Take the coin', actions: [{ type: 'currency', amount: 20 }] },
          ],
        }
      : null;
  switch (areaIndex % 3) {
    case 0: {
      // spawn (3) + offer (1 + 3) = 7
      if (hostile) out.push({ type: 'spawn', actor: hostile, count: 1, near: 'random' });
      const o = offer();
      if (o) out.push(o);
      break;
    }
    case 1: {
      // add_rule (4) + offer (4) = 8
      out.push({ type: 'add_rule', rule: simRule(), reason: 'The world shifts a little in your favour.' });
      const o = offer();
      if (o) out.push(o);
      break;
    }
    default: {
      // remove_rule (2) + spawn (3) + grant_xp (2) = 7
      out.push({ type: 'remove_rule', id: SIM_RULE_ID, reason: 'The respite ends.' });
      if (hostile) out.push({ type: 'spawn', actor: hostile, count: 1, near: 'random' });
      out.push({ type: 'grant_xp', amount: 10 });
      break;
    }
  }
  return out;
}

/** idle-hook actions every `every` turns (budget permitting: the engine skips what doesn't fit) */
export function gmIdleActions(state: GameState): GmAction[] {
  return [
    { type: 'mood', music: 'tense' },
    { type: 'effect', target: 'player', effects: [{ type: 'heal', amount: { base: 2 } }] },
  ].map((a) => a as GmAction).filter(() => state.status === 'playing');
}
