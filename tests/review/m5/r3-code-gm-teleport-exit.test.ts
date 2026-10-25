/**
 * Review M5 round 3 (code): help ceiling bypass. isHelpfulAction lists the player effects that help
 * (heal, buffs, xp, money, gifts, allies), but not `teleport` with mode 'to_exit'. A GM effect
 * `{target:'player', effects:[{type:'teleport', mode:'to_exit'}]}` puts the player next to the
 * area exit from anywhere in the area: in an area without a lock that skips the whole area (every
 * hostile and hazard on the way) — the strongest help a GM can give — yet it is never counted
 * against HELPFUL_CEILING, and every check accepts it on every hook but intro/death/victory.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../../src/schema/refs';
import type { WorldSpec } from '../../../src/schema/world';
import { GmAction } from '../../../src/schema/gm';
import { applyGmActions } from '../../../src/engine/index';
import { applyHelpCeiling, gmActionProblems, isHelpfulAction } from '../../../src/llm/gm-checks';
import { playToSituation } from '../../../src/llm/situation';
import { cheb } from '../../../src/client/travel';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

describe('GM teleport to the exit', () => {
  it('counts as help (it skips the area), so the area ceiling limits it', () => {
    const world = fixture('nb-nordisk-noir-tromso'); // area 0 has no lock
    const sit = playToSituation(world, { seed: 1, area: 0, turnsInArea: 1 });
    expect(sit.reached).toBe(true);
    const s0 = sit.state;
    const me = () => s0.area.actors.find((a) => a.id === s0.player.actorId)!;
    const before = cheb(me().pos, s0.area.map.exit);
    expect(before).toBeGreaterThan(10);

    const hop = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'teleport', mode: 'to_exit' }] });
    expect(gmActionProblems(world, s0, [hop])).toEqual([]);
    const s1 = applyGmActions(s0, [hop], { world }).state;
    const pl = s1.area.actors.find((a) => a.id === s1.player.actorId)!;
    // the player now stands at the exit of an area they had barely entered
    expect(cheb(pl.pos, s1.area.map.exit)).toBeLessThanOrEqual(6);

    // with the ceiling already used up, the hop still goes through
    const capped = applyHelpCeiling(world, [hop], 0, s0);
    expect({ helpful: isHelpfulAction(world, hop, s0), keptAtZeroCeiling: capped.actions.length }).toEqual({ helpful: true, keptAtZeroCeiling: 0 });
  });
});
