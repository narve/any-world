/**
 * M2 balance fixes (issues/M2-balance-*.md, issues/M2-sim-random-wander.md): hostile NPC bosses are
 * rebalanced, tuneWorld keeps progress and feasibility fixes, resource drains count their refills,
 * difficulty bands use the client's four levels, and random-bot wandering is not a soft-lock.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadFixture, testWorld, roomMap } from '../engine/helpers';
import { parseWorld } from '../../src/schema';
import {
  staticAnalysis,
  resourceDrainHarm,
  verdictFor,
  rebalance,
  autoRebalance,
  tuneWorld,
  tuneDistance,
  topKiller,
  scaleAmount,
  targetFor,
  WIN_RATE_TARGETS,
  DIFFICULTIES,
  type BalanceReport,
  type StaticAnalysis,
} from '../../src/engine/balance';
import { runGame } from '../../src/engine/sim/run';
import type { BotSummary } from '../../src/engine/sim/run';
import type { MapGenerator } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const root = resolve(__dirname, '../..');

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
    deathsByCause: {},
    stuckCauses: {},
    timeoutCauses: {},
    crashCauses: {},
    areaHistogram: [runs - won, 0, won],
    avgKills: 5,
    avgLevel: 2,
    invalidLegal: 0,
    seeds: { won: [], lost: [], stuck: [], crash: [], timeout: [] },
    ...extra,
  };
}
const clean = (sa: StaticAnalysis): StaticAnalysis => ({ ...sa, issues: [] });
const hp = (w: WorldSpec, id: string) => w.actors.find((a) => a.id === id)!.stats.hp;

describe('rebalance scales hostile NPC bosses', () => {
  const western = loadFixture('fixture-western.json');
  const teen = loadFixture('fixture-teen.json');

  it('too_hard weakens hostiles with npc dialogue (Absalom Vane, Sabine Lark) but keeps their persuade DC', () => {
    const v = verdictFor(western, clean(staticAnalysis(western)), [summary('explorer', 0)], 'normal');
    const res = rebalance(western, { ...v, sims: [summary('explorer', 0)] });
    expect(res.valid).toBe(true);
    for (const id of ['absalom-vane', 'sabine-lark']) {
      expect(hp(res.world, id), id).toBeLessThan(hp(western, id));
      const before = western.actors.find((a) => a.id === id)!;
      const after = res.world.actors.find((a) => a.id === id)!;
      expect(after.npc?.persuadeDifficulty).toBe(before.npc?.persuadeDifficulty);
    }
    // non-hostile actors are never touched
    for (const a of western.actors.filter((x) => x.faction !== 'hostile')) expect(hp(res.world, a.id), a.id).toBe(a.stats.hp);
  });

  it('too_easy toughens Mags and Rosalind (teen)', () => {
    const v = verdictFor(teen, clean(staticAnalysis(teen)), [summary('explorer', 20)], 'normal');
    const w2 = autoRebalance(teen, v);
    for (const id of ['mags-calloway', 'rosalind']) expect(hp(w2, id), id).toBeGreaterThan(hp(teen, id));
  });

  it('the top killer is found even when the death cause carries more than the name', () => {
    const def = topKiller(western, { 'killed by Absalom Vane, the Rain Broker (Storm)': 9, 'killed by Sabine Lark': 5, 'killed by Company Deputy': 6 });
    expect(def?.id).toBe('absalom-vane');
    const v = verdictFor(western, clean(staticAnalysis(western)), [summary('explorer', 0)], 'normal');
    const sims = [summary('explorer', 0, 20, { deathsByCause: { 'killed by Absalom Vane, the Rain Broker (Storm)': 20 } })];
    const res = rebalance(western, { ...v, sims });
    // ×0.7 for every hostile, then ×0.85 for the top killer
    expect(hp(res.world, 'absalom-vane')).toBe(Math.round(Math.round(hp(western, 'absalom-vane') * 0.7) * 0.85));
    expect(res.changes.join('\n')).toMatch(/absalom-vane: hp and damage ×0.85/);
  });

  it('tuneWorld improves a world whose NPC bosses deal ×3 damage', { timeout: 300_000 }, () => {
    const w = structuredClone(western);
    for (const a of w.actors) {
      if (a.faction !== 'hostile' || !a.npc) continue;
      a.stats.hp = Math.min(500, a.stats.hp * 2);
      if (a.attack) a.attack = { ...a.attack, damage: scaleAmount(a.attack.damage, 3) };
    }
    // 12 seeds: 0/8 wins is not confidently below the 25% band (90% Wilson upper bound 25.3%)
    const r = tuneWorld(w, { seeds: 12, bots: ['explorer'], fast: true, rounds: 2 });
    expect(r.history[0].verdict).toBe('too_hard');
    // the verdict was re-checked on a fresh block of 12 seeds before anything was changed
    expect(r.history[0].runs).toBe(24);
    expect(r.report.winRate).toBeGreaterThan(r.history[0].winRate);
    expect(hp(r.world, 'absalom-vane')).toBeLessThan(hp(w, 'absalom-vane'));
  });
});

describe('tuneWorld keeps progress and feasibility fixes', () => {
  const western = loadFixture('fixture-western.json');
  const report = (verdict: BalanceReport['verdict'], winRate: number, hist: number[], issues: string[] = []): BalanceReport =>
    ({
      world: 'x',
      difficulty: 'normal',
      verdict,
      winRate,
      target: [0.25, 0.6],
      reasons: [],
      suggestions: [],
      static: { issues } as StaticAnalysis,
      sims: [summary('explorer', Math.round(winRate * 20), 20, { areaHistogram: hist })],
    }) as BalanceReport;

  it('ranks progress inside the same verdict', () => {
    // 0% wins either way, but dying later is better
    expect(tuneDistance(report('too_hard', 0, [0, 10, 10]))).toBeLessThan(tuneDistance(report('too_hard', 0, [20, 0, 0])));
    // a higher win rate below the band is better
    expect(tuneDistance(report('too_hard', 0.2, [16, 0, 4]))).toBeLessThan(tuneDistance(report('too_hard', 0.05, [0, 19, 1])));
    // fewer static issues is better even when still unwinnable
    expect(tuneDistance(report('unwinnable', 0, [20, 0, 0], ['a']))).toBeLessThan(tuneDistance(report('unwinnable', 0, [20, 0, 0], ['a', 'b'])));
    // the verdict class still dominates
    expect(tuneDistance(report('too_hard', 0, [20, 0, 0]))).toBeLessThan(tuneDistance(report('unwinnable', 0.5, [0, 0, 20], ['a'])));
    expect(tuneDistance(report('ok', 0.4, [12, 0, 8]))).toBe(0);
  });

  it('keeps a placed lock item although another issue keeps the world unwinnable', { timeout: 120_000 }, () => {
    // review repro (scratchpad/unwin.ts): lode-key only in area 3, plus a drain that kills and nothing refills
    const raw = structuredClone(western) as WorldSpec;
    raw.areas[1].placedItems = raw.areas[1].placedItems.filter((p) => p.item !== 'lode-key');
    raw.areas[2].placedItems.push({ item: 'lode-key', where: 'anywhere' });
    for (const a of raw.actors) a.loot = a.loot.filter((l) => l.item !== 'lode-key');
    raw.resources = [...raw.resources, { id: 'thirst', name: 'Water', description: 'drains', color: '#3388ff', max: 60, start: 60, perTurn: -1, onEmpty: [], emptyIsDeath: true }];
    const parsed = parseWorld(JSON.parse(JSON.stringify(raw)));
    expect(parsed.ok).toBe(true);
    const w = (parsed as { world: WorldSpec }).world;
    expect(staticAnalysis(w).issues).toHaveLength(2);
    const r = tuneWorld(w, { seeds: 2, bots: ['explorer'], fast: true, rounds: 2 });
    expect(r.history[0].verdict).toBe('unwinnable');
    expect(r.history[1].changes.join('\n')).toMatch(/placed missing item "lode-key" in area 2/);
    expect(r.world.areas[1].placedItems.some((p) => p.item === 'lode-key')).toBe(true);
    expect(r.report.static.issues).toHaveLength(1);
  });
});

describe('resource drains count their refills', () => {
  it('ship and dream: refills (canisters, moss, area-entry top-ups) keep most areas out of the red', () => {
    for (const f of ['fixture-ship.json', 'fixture-dream.json']) {
      const w = loadFixture(f);
      const sa = staticAnalysis(w);
      const drain = sa.resources.find((r) => w.resources.find((x) => x.id === r.id)!.perTurn < 0)!;
      expect(drain.refills.every((n) => n > 0), f).toBe(true);
      // previously ~170–190 rule damage in every area; now only where the drain outruns the refills
      expect(sa.areas.filter((a) => a.ruleDamage > 100).length, f).toBeLessThanOrEqual(1);
      expect(sa.areas[0].risk, f).toBeLessThan(1);
    }
  });

  it('a drain with nothing refilling it is still harmful, and refills reduce the harm', () => {
    const ship = loadFixture('fixture-ship.json');
    const dry = structuredClone(ship);
    for (const a of dry.areas) a.items = a.items.filter((e) => !['o2-canister'].includes(e.item));
    dry.terrains = dry.terrains.map((t) => ({ ...t, onStand: t.onStand.filter((e) => !(e.type === 'resource' && e.resource === 'oxygen')) }));
    dry.rules = dry.rules.map((r) => ({ ...r, playerTriggers: r.playerTriggers.filter((tr) => tr.on !== 'on_area_enter') }));
    const wet = resourceDrainHarm(ship).find((r) => r.id === 'oxygen')!;
    const parched = resourceDrainHarm(dry).find((r) => r.id === 'oxygen')!;
    expect(parched.hpPer100).toBeGreaterThan(wet.hpPer100);
    expect(parched.emptyTurns.reduce((a, b) => a + b, 0)).toBeGreaterThan(wet.emptyTurns.reduce((a, b) => a + b, 0));
    expect(parched.perArea.every((h) => h > 0)).toBe(true);
  });

  it('too_easy verdicts never suggest adding healing', () => {
    const w = loadFixture('fixture-western.json');
    const sa = clean(staticAnalysis(w));
    expect(sa.areas.some((a) => a.risk > 1)).toBe(true);
    const easy = verdictFor(w, sa, [summary('explorer', 20)], 'normal');
    expect(easy.verdict).toBe('too_easy');
    expect(easy.suggestions.join('\n')).not.toMatch(/add healing/);
    const hard = verdictFor(w, sa, [summary('explorer', 0)], 'normal');
    expect(hard.suggestions.join('\n')).toMatch(/add healing to its item table/);
  });
});

describe('difficulty bands', () => {
  it('use the client levels gentle / normal / hard / brutal', () => {
    expect([...DIFFICULTIES]).toEqual(['gentle', 'normal', 'hard', 'brutal']);
    expect(Object.keys(WIN_RATE_TARGETS).sort()).toEqual([...DIFFICULTIES].sort());
    expect(targetFor('brutal')).toEqual([0.05, 0.25]);
    expect(targetFor('gentle')).toEqual([0.5, 0.85]);
    // the bands get stricter with each level
    for (let i = 1; i < DIFFICULTIES.length; i++) expect(WIN_RATE_TARGETS[DIFFICULTIES[i]][0]).toBeLessThan(WIN_RATE_TARGETS[DIFFICULTIES[i - 1]][0]);
  });

  it('unknown difficulties are rejected, not silently treated as normal', () => {
    expect(() => targetFor('easy')).toThrow(/unknown difficulty "easy"/);
    const w = testWorld();
    expect(() => verdictFor(w, clean(staticAnalysis(w)), [summary('explorer', 8)], 'easy' as never)).toThrow(/unknown difficulty/);
    const brutal = verdictFor(w, clean(staticAnalysis(w)), [summary('explorer', 4)], 'brutal');
    expect(brutal.verdict).toBe('ok');
    expect(brutal.reasons.join(' ')).toMatch(/5%–25% for brutal/);
  });

  it('tools/sim.ts refuses an unknown --difficulty', { timeout: 60_000 }, () => {
    let err: { status?: number; stderr?: Buffer } | null = null;
    try {
      execFileSync('npx', ['tsx', 'tools/sim.ts', '--world', 'content/worlds/fixture-teen.json', '--seeds', '1', '--analyse', '--difficulty', 'easy'], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      err = e as { status?: number; stderr?: Buffer };
    }
    expect(err?.status).toBe(1);
    expect(String(err?.stderr)).toMatch(/unknown difficulty "easy" \(known: gentle, normal, hard, brutal\)/);
  });
});

describe('random-bot wandering is not a soft-lock', () => {
  const world = testWorld((w) => {
    delete (w.areas[0] as { transitionRequires?: unknown }).transitionRequires;
  });
  const open: MapGenerator = () => roomMap(12, 10);

  it('a random bot that stops making progress times out as wandering', () => {
    const r = runGame(world, 3, 'random', { mapGenerator: open, maxTurns: 5000, stallSteps: 60 });
    expect(r.result).not.toBe('stuck');
    if (r.result === 'timeout') expect(r.cause).toMatch(/^wandering: no progress for 60 actions|^turn cap/);
  });

  it('goal-seeking bots still report soft-locks as stuck', () => {
    const walls: { x: number; y: number }[] = [];
    for (let x = 8; x <= 10; x++) walls.push({ x, y: 6 });
    walls.push({ x: 8, y: 7 }, { x: 8, y: 8 });
    const sealed: MapGenerator = () => roomMap(12, 10, { walls });
    expect(runGame(world, 3, 'explorer', { mapGenerator: sealed, maxTurns: 5000, stallSteps: 150 }).result).toBe('stuck');
    const rnd = runGame(world, 3, 'random', { mapGenerator: sealed, maxTurns: 5000, stallSteps: 150 });
    expect(rnd.result).toBe('timeout');
    expect(rnd.cause).toMatch(/^wandering: no progress for 150 actions in area 0/);
  });
});
