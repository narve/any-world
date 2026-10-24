/** Static budgets, rule impact, verdicts and auto-rebalancing. */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture, testWorld } from '../engine/helpers';
import { parseWorld, RuleVariant } from '../../src/schema';
import {
  staticAnalysis,
  estimateRuleImpact,
  verdictFor,
  analyseWorld,
  rebalance,
  autoRebalance,
  scaleAmount,
  tuneWorld,
  expectedActors,
  WIN_RATE_TARGETS,
  type StaticAnalysis,
} from '../../src/engine/balance';
import type { BotSummary } from '../../src/engine/sim/run';

const files = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json')).sort();

function summary(bot: string, won: number, runs = 20, extra: Partial<BotSummary> = {}): BotSummary {
  return {
    bot,
    runs,
    won,
    lost: runs - won,
    stuck: 0,
    crash: 0,
    timeout: 0,
    winRate: won / runs,
    avgTurns: 500,
    avgTurnsWon: 500,
    deathsByCause: runs - won ? { 'killed by Golem': runs - won } : {},
    stuckCauses: {},
    timeoutCauses: {},
    crashCauses: {},
    areaHistogram: [0, runs],
    avgKills: 5,
    avgLevel: 2,
    invalidLegal: 0,
    seeds: { won: [], lost: [], stuck: [], crash: [], timeout: [] },
    ...extra,
  };
}

const cleanStatic = (sa: StaticAnalysis): StaticAnalysis => ({ ...sa, issues: [] });

describe('rule impact', () => {
  const world = testWorld();
  const rule = (input: unknown) => RuleVariant.parse(input);
  const self = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false };
  it('per-turn damage is harmful, healing helpful, mercy helpful', () => {
    const burn = estimateRuleImpact(world, rule({ id: 'burn', name: 'Burn', description: 'd', playerTriggers: [{ on: 'on_turn', every: 10, action: { targeting: self, effects: [{ type: 'damage', amount: { base: 2 } }] } }] }));
    expect(burn.harmful).toBe(true);
    expect(burn.hpPer100).toBeCloseTo(20, 0);
    expect(burn.magnitude).toBe('major');
    const mend = estimateRuleImpact(world, rule({ id: 'mend', name: 'Mend', description: 'd', playerTriggers: [{ on: 'on_turn', every: 20, action: { targeting: self, effects: [{ type: 'heal', amount: { base: 1 } }] } }] }));
    expect(mend.harmful).toBe(false);
    expect(mend.hpPer100).toBeLessThan(0);
    const mercy = estimateRuleImpact(world, rule({ id: 'mercy', name: 'Mercy', description: 'd', switches: { permadeathMercy: true } }));
    expect(mercy.hpPer100).toBeLessThan(0);
    const dark = estimateRuleImpact(world, rule({ id: 'dark', name: 'Dark', description: 'd', switches: { darkness: 0.5, noLoot: true } }));
    expect(dark.harmful).toBe(true);
    expect(dark.notes.length).toBe(2);
  });
});

describe('static analysis', () => {
  it('finds no hard issues in the fixture worlds and budgets every area', () => {
    for (const f of files) {
      const world = loadFixture(f);
      const sa = staticAnalysis(world);
      expect(sa.issues, f).toEqual([]);
      expect(sa.areas).toHaveLength(world.areas.length);
      for (const a of sa.areas) {
        expect(a.playerHp).toBeGreaterThan(0);
        expect(a.playerDpt).toBeGreaterThan(0);
        expect(Number.isFinite(a.risk)).toBe(true);
      }
      // the player grows over the run
      expect(sa.areas[sa.areas.length - 1].playerLevel).toBeGreaterThanOrEqual(sa.areas[0].playerLevel);
    }
  });

  it('flags a transition lock whose item only appears in a later area (unwinnable)', () => {
    // the test world locks area 1 behind a key that is only placed in area 2
    const world = testWorld();
    const sa = staticAnalysis(world);
    expect(sa.issues.join('\n')).toMatch(/area 1 .* can never be left: item "key" first appears in area 2/);
  });

  it('flags goals that need things that never exist or appear (specs built past the validator)', () => {
    const w1 = structuredClone(testWorld());
    w1.goal.win = { type: 'all', of: [{ type: 'has_item', who: 'player', item: 'bow' }, { type: 'actor_defeated', actor: 'boss' }] };
    expect(staticAnalysis(w1).issues.join('\n')).toMatch(/item "bow" is never placed/);
    const w2 = structuredClone(testWorld());
    w2.goal.win = { type: 'flag', flag: 'never-set' };
    expect(staticAnalysis(w2).issues.join('\n')).toMatch(/flag "never-set" is never set/);
    const w3 = structuredClone(testWorld());
    w3.goal.win = { type: 'any', of: [{ type: 'flag', flag: 'never-set' }, { type: 'actor_defeated', actor: 'boss' }] };
    expect(staticAnalysis(w3).issues.filter((i) => i.startsWith('goal'))).toEqual([]);
  });

  it('expected spawns respect minimums, placements and the size budget', () => {
    const world = testWorld();
    const exp = expectedActors(world, 1);
    expect(exp.get('boss')).toBe(1);
    // rat: min 1, max 2, small area adds up to 2 extra spawns but only 1 more fits
    expect(exp.get('rat')).toBeCloseTo(2, 5);
  });

  it('a stronger hostile raises the risk', () => {
    const base = staticAnalysis(testWorld());
    const harder = staticAnalysis(
      testWorld((w) => {
        for (const a of w.actors) if (a.id === 'rat') a.attack = { name: 'Bite', verb: 'bites', damage: { base: 6, dice: '2d6' }, range: 1 };
      }),
    );
    expect(harder.areas[1].risk).toBeGreaterThan(base.areas[1].risk);
  });
});

describe('verdicts', () => {
  const world = testWorld();
  const sa = cleanStatic(staticAnalysis(world));
  it('maps win rates to the difficulty band', () => {
    expect(verdictFor(world, sa, [summary('explorer', 8)], 'normal').verdict).toBe('ok');
    expect(verdictFor(world, sa, [summary('explorer', 1)], 'normal').verdict).toBe('too_hard');
    expect(verdictFor(world, sa, [summary('explorer', 19)], 'normal').verdict).toBe('too_easy');
    expect(verdictFor(world, sa, [summary('explorer', 3)], 'hard').verdict).toBe('ok');
    expect(verdictFor(world, sa, [summary('explorer', 3)], 'gentle').verdict).toBe('too_hard');
    expect(WIN_RATE_TARGETS.normal).toEqual([0.25, 0.6]);
  });
  it('crashes make a world broken, soft-locks too', () => {
    const crashed = summary('explorer', 8, 20, { crash: 1, crashCauses: { 'engine: boom': 1 }, seeds: { won: [], lost: [], stuck: [], crash: [7], timeout: [] } });
    const v = verdictFor(world, sa, [crashed], 'normal');
    expect(v.verdict).toBe('broken');
    expect(v.reasons.join(' ')).toMatch(/seeds 7/);
    const stuck = summary('cautious', 5, 20, { stuck: 5, stuckCauses: { 'no progress (locked)': 5 } });
    expect(verdictFor(world, sa, [summary('explorer', 8), stuck], 'normal').verdict).toBe('broken');
  });
  it('static impossibility makes a world unwinnable, with a placement suggestion', () => {
    const v = verdictFor(world, staticAnalysis(world), [summary('explorer', 0)], 'normal');
    expect(v.verdict).toBe('unwinnable');
    expect(v.suggestions.join('\n')).toMatch(/place "key"/);
  });
  it('too_hard names the top killer', () => {
    const v = verdictFor(world, sa, [summary('explorer', 1)], 'normal');
    expect(v.suggestions.join('\n')).toMatch(/Golem/);
  });
});

describe('rebalancing', () => {
  it('scales dice and bases within bounds', () => {
    expect(scaleAmount({ base: 4, dice: '2d6' }, 0.5)).toEqual({ base: 2, dice: '2d3' });
    expect(scaleAmount({ base: 1, dice: '1d2' }, 0.5)).toEqual({ base: 1, dice: '1d2' });
    expect(scaleAmount({ base: 0, dice: '1d8', scale: { stat: 'str', factor: 0.5 } }, 1.5)).toEqual({ base: 0, dice: '1d12', scale: { stat: 'str', factor: 0.75 } });
  });

  it('places a missing lock item, after which the world is winnable on paper', () => {
    const world = testWorld();
    const res = rebalance(world, verdictFor(world, staticAnalysis(world), [summary('explorer', 0)], 'normal'));
    expect(res.valid).toBe(true);
    expect(res.changes.join('\n')).toMatch(/placed missing item "key" in area 1/);
    expect(res.world.areas[0].placedItems.some((p) => p.item === 'key')).toBe(true);
    expect(staticAnalysis(res.world).issues).toEqual([]);
  });

  it('too_hard: weaker hostiles, more healing, softer rules — and still a valid world', () => {
    const world = loadFixture('fixture-ship.json');
    const v = { ...verdictFor(world, cleanStatic(staticAnalysis(world)), [summary('explorer', 0)], 'normal'), sims: [summary('explorer', 0)] };
    expect(v.verdict).toBe('too_hard');
    const res = rebalance(world, v);
    expect(res.valid).toBe(true);
    const before = world.actors.find((a) => a.id === 'custodian-unit')!;
    const after = res.world.actors.find((a) => a.id === 'custodian-unit')!;
    expect(after.stats.hp).toBeLessThan(before.stats.hp);
    const npcBefore = world.actors.find((a) => a.id === 'sister-ula')!;
    expect(res.world.actors.find((a) => a.id === 'sister-ula')!.stats.hp).toBe(npcBefore.stats.hp);
    const healBefore = world.areas.reduce((n, a) => n + a.itemCount, 0);
    expect(res.world.areas.reduce((n, a) => n + a.itemCount, 0)).toBeGreaterThan(healBefore);
    expect(res.world.resources[0].perTurn).toBeGreaterThan(world.resources[0].perTurn);
    expect(parseWorld(JSON.parse(JSON.stringify(res.world))).ok).toBe(true);
    // the input is never mutated
    expect(world.actors.find((a) => a.id === 'custodian-unit')!.stats.hp).toBe(before.stats.hp);
  });

  it('too_easy: tougher hostiles and rarer healing', () => {
    const world = loadFixture('fixture-teen.json');
    const v = verdictFor(world, cleanStatic(staticAnalysis(world)), [summary('explorer', 20)], 'normal');
    expect(v.verdict).toBe('too_easy');
    const w2 = autoRebalance(world, v);
    const id = 'senior-prankster';
    expect(w2.actors.find((a) => a.id === id)!.stats.hp).toBeGreaterThan(world.actors.find((a) => a.id === id)!.stats.hp);
    const healW = (w: typeof world) => w.areas.flatMap((a) => a.items).filter((e) => e.item === 'iced-tea').reduce((n, e) => n + e.weight, 0);
    expect(healW(w2)).toBeLessThanOrEqual(healW(world));
  });

  it('ok worlds are returned unchanged', () => {
    const world = loadFixture('fixture-western.json');
    const v = verdictFor(world, cleanStatic(staticAnalysis(world)), [summary('explorer', 9)], 'normal');
    expect(v.verdict).toBe('ok');
    const res = rebalance(world, v);
    expect(res.world).toBe(world);
    expect(res.changes).toEqual(['no changes']);
  });
});

describe('analyseWorld', () => {
  it('combines static analysis and simulations into a report', { timeout: 120_000 }, () => {
    const world = loadFixture('fixture-western.json');
    const r = analyseWorld(world, { seeds: 4, bots: ['explorer'], fast: true });
    expect(r.sims).toHaveLength(1);
    expect(r.sims[0].runs).toBe(4);
    expect(r.sims[0].crash).toBe(0);
    expect(['ok', 'too_hard', 'too_easy']).toContain(r.verdict);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.static.areas).toHaveLength(world.areas.length);
  });
});

describe('tuneWorld', () => {
  it('fixes an unwinnable world and records each round', { timeout: 120_000 }, () => {
    const world = testWorld();
    const r = tuneWorld(world, { seeds: 2, bots: ['explorer'], fast: true, rounds: 1 });
    expect(r.history[0].verdict).toBe('unwinnable');
    expect(r.history[1].changes.join('\n')).toMatch(/placed missing item "key"/);
    expect(r.report.static.issues).toEqual([]);
    expect(r.world.areas[0].placedItems.some((p) => p.item === 'key')).toBe(true);
  });
});
