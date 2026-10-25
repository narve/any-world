/**
 * Review M5 round 3 (code): GM fiat through a copy of the goal actor. actor_defeated counts every
 * death of an actor of that def (engine combat.finishKill: `defeated[defId]++`, whoever killed it
 * and whichever side it was on). goal-refs / gm-checks protect the goal actor from GM damage,
 * transform and change_faction, but not from being CREATED: an `effect` on the player with
 * `summon` of the goal actor's def, or a `spawn` action of it, passes every check — even for a
 * `unique` def that already exists in a later area.
 *
 * Nordic noir (nb): win = actor_defeated "ragnhild" (the final boss, area 3). In area 0 the GM
 * summons an ALLIED Ragnhild next to the player (one "help"). The engine lets the player attack an
 * ally, the ally never fights back, and after ~30–50 bumps the run is WON in the first area with
 * the player at full health.
 *
 * STATUS (llm fixer): the gm-checks half is fixed and lives in tests/llm/gm-fiat-r3.test.ts (spawn /
 * summon of goal or unique defs is refused). What stays here is the ENGINE half (owner: engine):
 * applied without the checks, an allied copy can still be bumped to death by the player.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../../src/schema/refs';
import type { WorldSpec } from '../../../src/schema/world';
import { GmAction } from '../../../src/schema/gm';
import { applyGmActions, legalActions, step } from '../../../src/engine/index';
import { playToSituation } from '../../../src/llm/situation';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

describe('GM creates a copy of the goal actor', () => {
  const world = fixture('nb-nordisk-noir-tromso');

  it('an allied copy summoned in area 0 cannot be bumped to death for a first-area win', () => {
    const sit = playToSituation(world, { seed: 2, area: 0, turnsInArea: 1 });
    expect(sit.reached).toBe(true);
    const summon = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'summon', actor: 'ragnhild', count: 1, allied: true }] });
    let s = applyGmActions(sit.state, [summon], { world }).state;
    const copy = s.area.actors.find((a) => a.defId === 'ragnhild');
    expect(copy).toBeTruthy();
    for (let i = 0; i < 200 && s.status === 'playing'; i++) {
      const atk = legalActions(s, { world }).find((a) => a.type === 'attack' && a.targetId === copy!.id);
      if (!atk) break;
      s = step(s, atk, { world }).state;
    }
    expect({ area: s.area.index, status: s.status }).not.toEqual({ area: 0, status: 'won' });
  });
});
