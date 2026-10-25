/**
 * M5 round 3 regressions (GM fiat), moved here from tests/review/m5/r3-code-gm-*.test.ts:
 *  - spawn / summon (also inside add_rule triggers and offer options) of a goal actor's def or of
 *    any unique def is refused (issues/M5-gm-summon-goal-copy.md);
 *  - add_rule triggers are bounded like `effect` actions and may not strike the player's foes, and
 *    such a rule counts as help (issues/M5-gm-rule-fiat.md);
 *  - harmful statuses count towards the lethal-damage check and GM durations are capped
 *    (issues/M5-gm-status-dot.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { GmAction } from '../../src/schema/gm';
import type { GameState } from '../../src/engine/types';
import { applyGmActions, step } from '../../src/engine/index';
import { GM_AMOUNT_LIMIT, GM_HARMFUL_STATUS_TURNS, gmActionProblems, goalRefs, isHelpfulAction } from '../../src/llm/gm-checks';
import { playToSituation } from '../../src/llm/situation';
import { botByName, newMemory } from '../../src/engine/sim/bots';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const refused = (world: WorldSpec, state: GameState, a: unknown) => gmActionProblems(world, state, [GmAction.parse(a)]);

describe('GM creating a copy of the goal actor', () => {
  const world = fixture('nb-nordisk-noir-tromso');
  const sit = playToSituation(world, { seed: 1, area: 0, turnsInArea: 1 });

  it('refuses spawn, summon, transform into and rule / offer summons of the goal def', () => {
    expect(goalRefs(world).actors.has('ragnhild')).toBe(true);
    expect(sit.reached).toBe(true);
    const s = sit.state;
    const summon = { type: 'summon', actor: 'ragnhild', count: 1, allied: true };
    const cases = {
      spawn: { type: 'spawn', actor: 'ragnhild', count: 1, near: 'player' },
      summon: { type: 'effect', target: 'player', effects: [summon] },
      hostileSummon: { type: 'effect', target: 'player', effects: [{ ...summon, allied: false }] },
      offer: {
        type: 'offer_choice',
        prompt: 'A figure in the snow.',
        options: [{ label: 'Call her', actions: [{ type: 'effect', target: 'player', effects: [summon] }] }, { label: 'Walk on', actions: [] }],
      },
      rule: {
        type: 'add_rule',
        reason: 'She follows.',
        rule: { id: 'gm-shadow', name: 'Shadow', description: 'She follows you.', playerTriggers: [{ on: 'on_area_enter', action: { effects: [summon] } }] },
      },
    };
    for (const [name, a] of Object.entries(cases)) {
      const p = refused(world, s, a);
      expect(p.length, name).toBe(1);
      expect(p[0]!.message, name).toMatch(/ragnhild/);
    }
  });

  it('refuses spawn / summon of any unique def, even one the goal does not name', () => {
    const unique = world.actors.find((d) => d.unique && !goalRefs(world).actors.has(d.id));
    expect(unique).toBeTruthy();
    expect(refused(world, sit.state, { type: 'spawn', actor: unique!.id, count: 1, near: 'random' })[0]?.message).toMatch(/unique/);
    expect(refused(world, sit.state, { type: 'effect', target: 'player', effects: [{ type: 'summon', actor: unique!.id }] })[0]?.message).toMatch(/unique/);
  });

  it('still allows spawning an ordinary actor', () => {
    const plain = world.actors.find((d) => !d.unique && !d.npc && !goalRefs(world).actors.has(d.id) && (d.faction ?? 'hostile') === 'hostile');
    expect(plain).toBeTruthy();
    expect(refused(world, sit.state, { type: 'spawn', actor: plain!.id, count: 1, near: 'random' })).toEqual([]);
  });
});

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
      if (boss && s.area.seen[boss.pos.y * s.area.map.width + boss.pos.x] === 2) return s;
      s = step(s, bot.decide(s, world, mem), { world }).state;
    }
  }
  return null;
}

describe('GM add_rule is held to the effect checks', () => {
  const teen = fixture('fixture-teen');
  const wrath = (amount: number, affects: 'enemies' | 'all' | 'self_only' = 'enemies', shape: 'all_visible' | 'self' = 'all_visible') => ({
    type: 'add_rule',
    reason: 'The air itself turns against the debate team.',
    rule: {
      id: 'gm-wrath',
      name: 'Wrath',
      description: 'Every turn, everyone against you is struck.',
      playerTriggers: [{ on: 'on_turn', action: { targeting: { shape, range: 20, affects, needsLos: false }, effects: [{ type: 'damage', amount: { base: amount } }] } }],
    },
  });

  it('refuses a rule that deals 100000 damage to all visible enemies with the goal boss in sight, and counts it as help', () => {
    const state = bossInSight(teen, 2, 'mags-calloway');
    expect(state).not.toBeNull();
    const rule = GmAction.parse(wrath(100000));
    expect(gmActionProblems(teen, state!, [rule]).length).toBe(1);
    expect(isHelpfulAction(teen, rule, state!)).toBe(true);
    // the runtime keeps only what the checks accept, so the boss survives the next turns
    const kept = gmActionProblems(teen, state!, [rule]).length ? [] : [rule];
    let s = applyGmActions(state!, kept, { world: teen }).state;
    for (let i = 0; i < 2 && s.status === 'playing'; i++) s = step(s, { type: 'wait' }, { world: teen }).state;
    const boss = s.area.actors.find((a) => a.defId === 'mags-calloway');
    expect(!!boss && boss.hp > 0).toBe(true);
  });

  it('bounds rule trigger amounts and refuses small foe-striking rules anywhere', () => {
    const sit = playToSituation(teen, { seed: 1, area: 1, turnsInArea: 1 });
    expect(sit.reached).toBe(true);
    // over the amount limit, even when aimed at the player
    expect(refused(teen, sit.state, wrath(GM_AMOUNT_LIMIT + 1, 'self_only', 'self'))[0]?.message).toMatch(/at most 50/);
    // a modest foe-striking rule: refused (it would keep firing at the goal's actors in later areas)
    expect(refused(teen, sit.state, wrath(2))[0]?.message).toMatch(/foes/);
    expect(refused(teen, sit.state, wrath(2, 'all'))[0]?.message).toMatch(/foes/);
    // a long harmful status inside a rule trigger is bounded too
    const status = teen.statuses.find((x) => x.harmful)!;
    const long = {
      ...wrath(1, 'self_only', 'self'),
      rule: {
        ...wrath(1, 'self_only', 'self').rule,
        playerTriggers: [{ on: 'on_area_enter', action: { effects: [{ type: 'apply_status', status: status.id, duration: GM_HARMFUL_STATUS_TURNS + 1 }] } }],
      },
    };
    expect(refused(teen, sit.state, long)[0]?.message).toMatch(/harmful status/);
  });
});

describe('GM harmful damage-over-time status on the player', () => {
  const world = fixture('folk-horror-scarecrow-wedding');
  const sit = playToSituation(world, { seed: 1, area: 0, turnsInArea: 1 });
  const alone = () => {
    const st = structuredClone(sit.state) as GameState;
    const pl = st.area.actors.find((a) => a.id === st.player.actorId)!;
    st.area.actors = [pl];
    return { st, pl };
  };
  const burn = (duration: number) => ({ type: 'effect', target: 'player', effects: [{ type: 'apply_status', status: 'smouldering', duration }] });

  it('refuses a 200-turn smouldering on the player', () => {
    expect(sit.reached).toBe(true);
    const { st } = alone();
    const p = refused(world, st, burn(200));
    expect(p.length).toBe(1);
    expect(p[0]!.message).toMatch(/harmful status|knock the player out/);
  });

  it('allows a short burn on a healthy player, refuses one that could finish a wounded player', () => {
    const { st, pl } = alone();
    expect(refused(world, st, burn(3))).toEqual([]);
    pl.hp = 4; // 1d3 for 3 turns can take up to 9
    expect(refused(world, st, burn(3))[0]?.message).toMatch(/knock the player out/);
  });

  it('counts a negative hp stat change towards lethal loss', () => {
    const { st, pl } = alone();
    pl.hp = 3;
    expect(refused(world, st, { type: 'effect', target: 'player', effects: [{ type: 'modify_stat', stat: 'hp', amount: -5 }] })[0]?.message).toMatch(/knock the player out/);
  });
});
