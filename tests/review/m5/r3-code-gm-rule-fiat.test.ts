/**
 * Review M5 round 3 (code): the round-2 fiat fix bounds and goal-checks the GM `effect` action
 * (GM_AMOUNT_LIMIT, stateGoalProblem: no harmful effects at enemies while a goal actor is in the
 * area), but `add_rule` carries the same Effects inside rule.playerTriggers with none of that:
 *  - boundProblem only looks at `effect` (and trade / offer_choice), so a trigger may carry
 *    damage 100000;
 *  - stateGoalProblem has no add_rule case, and goalWriteProblem only checks the trigger effects
 *    for flag / counter / stat / item writes;
 *  - estimateRuleImpact counts nothing for a trigger whose targeting affects 'enemies'
 *    (reachOfPlayer → 'never'), so the engine's power limit passes it and isHelpfulAction calls it
 *    not helpful (no help ceiling either);
 *  - the dry run (outcomeProblem) sees nothing, because the rule fires on the NEXT turn.
 * One add_rule then kills the goal boss (actor_defeated) on the player's next wait.
 *
 * STATUS (llm fixer): the gm-checks half is fixed and lives in tests/llm/gm-fiat-r3.test.ts (bounded,
 * refused, counted as help). What stays here is the ENGINE half (owner: engine, defence in depth):
 * applyGmActions without the checks still accepts the rule (its power limit ignores triggers aimed
 * at enemies) and the boss dies.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../../src/schema/refs';
import type { WorldSpec } from '../../../src/schema/world';
import { GmAction } from '../../../src/schema/gm';
import type { GameState } from '../../../src/engine/types';
import { applyGmActions, step, leadPlayer } from '../../../src/engine/index';
import { playToSituation } from '../../../src/llm/situation';
import { botByName, newMemory } from '../../../src/engine/sim/bots';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

/** play on until an actor of `defId` is visible to the player */
function bossInSight(world: WorldSpec, area: number, defId: string): GameState | null {
  for (let seed = 1; seed <= 30; seed++) {
    const sit = playToSituation(world, { seed, area });
    if (!sit.reached) continue;
    let s = sit.state;
    const bot = botByName('explorer');
    const mem = newMemory(seed);
    for (let i = 0; i < 1500 && s.status === 'playing' && s.area.index === area; i++) {
      const boss = s.area.actors.find((a) => a.defId === defId && a.hp > 0);
      if (boss && leadPlayer(s).seen[boss.pos.y * s.area.map.width + boss.pos.x] === 2) return s;
      s = step(s, bot.decide(s, world, mem), { world }).state;
    }
  }
  return null;
}

describe('GM add_rule as a back door for the fiat checks', () => {
  const teen = fixture('fixture-teen');
  const state = bossInSight(teen, 2, 'mags-calloway');

  it('a rule whose on_turn trigger deals 100000 damage to all visible enemies is refused while the goal boss is in the area', () => {
    expect(state).not.toBeNull();
    const rule = GmAction.parse({
      type: 'add_rule',
      reason: 'The air itself turns against the debate team.',
      rule: {
        id: 'gm-wrath',
        name: 'Wrath',
        description: 'Every turn, everyone against you is struck.',
        playerTriggers: [
          { on: 'on_turn', action: { targeting: { shape: 'all_visible', range: 20, affects: 'enemies', needsLos: false }, effects: [{ type: 'damage', amount: { base: 100000 } }] } },
        ],
      },
    });
    let s = applyGmActions(state!, [rule], { world: teen }).state;
    for (let i = 0; i < 2 && s.status === 'playing'; i++) s = step(s, { type: 'wait' }, { world: teen }).state;
    const boss = s.area.actors.find((a) => a.defId === 'mags-calloway');
    const bossDown = !boss || boss.hp <= 0;
    expect(bossDown).toBe(false);
  });
});
