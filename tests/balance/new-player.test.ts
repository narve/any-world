/**
 * New-player fixes and gate (issues/M5-new-player-deaths.md): a quiet first area (a few hostiles,
 * none that outrange the player), heals worth a quarter of max hp, and the newbie-bot win-rate
 * floors every demo world is held to.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { WORLD_DIR, loadFixture, testWorld } from '../engine/helpers';
import type { WorldSpec } from '../../src/schema';
import { itemProfile } from '../../src/engine/sim/view';
import type { SimResult } from '../../src/engine/sim/run';
import {
  newPlayerFixes,
  playerReach,
  hostileReach,
  FIRST_AREA_MAX_HOSTILES,
  FIRST_AREA_MAX_GUARANTEED,
  MIN_HEAL_SHARE,
  NEW_PLAYER_GATE,
  gateFromResults,
  formatGate,
  tuneWorld,
  verdictFor,
  staticAnalysis,
  NEW_PLAYER_FLOORS,
} from '../../src/engine/balance';
import { summarize } from '../../src/engine/sim/run';

const hostileEntries = (w: WorldSpec) => w.areas[0].actors.filter((e) => w.actors.find((a) => a.id === e.actor)?.faction === 'hostile');
const tableMax = (w: WorldSpec) => hostileEntries(w).reduce((n, e) => n + Math.max(e.min, e.max), 0);
const tableMin = (w: WorldSpec) => hostileEntries(w).reduce((n, e) => n + e.min, 0);

/** the test world with a crowded first area: rats ×6 (min 3), an archer that outranges the melee-only player, golems ×2 */
function crowded(): WorldSpec {
  return testWorld((w) => {
    w.areas[0].actors = [
      { actor: 'rat', weight: 10, min: 3, max: 6 },
      { actor: 'archer', weight: 5, min: 1, max: 2 },
      { actor: 'golem', weight: 2, min: 0, max: 2 },
    ];
    w.areas[0].size = 'medium';
  });
}

describe('newPlayerFixes', () => {
  it('caps the first area at a few hostiles, a couple guaranteed, the most dangerous cut first', () => {
    const w = crowded();
    expect(tableMax(w)).toBe(10);
    const r = newPlayerFixes(w);
    expect(r.valid).toBe(true);
    expect(tableMax(r.world)).toBeLessThanOrEqual(FIRST_AREA_MAX_HOSTILES.medium);
    expect(tableMin(r.world)).toBeLessThanOrEqual(FIRST_AREA_MAX_GUARANTEED);
    const by = (id: string) => r.world.areas[0].actors.find((e) => e.actor === id)!;
    // the golem (40 hp) goes before the rats (5 hp)
    expect(by('golem').max).toBe(0);
    expect(by('rat').max).toBeGreaterThan(0);
    // later areas are untouched
    expect(r.world.areas[1].actors).toEqual(w.areas[1].actors);
    expect(r.changes.join(' ')).toMatch(/spawn table capped/);
  });

  it('removes first-area hostiles that outrange everything the player has, unless a goal needs them', () => {
    const w = crowded();
    const archer = w.actors.find((a) => a.id === 'archer')!;
    expect(hostileReach(archer)).toBeGreaterThan(playerReach(w));
    const r = newPlayerFixes(w);
    expect(r.world.areas[0].actors.find((e) => e.actor === 'archer')).toMatchObject({ min: 0, max: 0 });
    expect(r.changes.join(' ')).toMatch(/outrange.*archer/);
    // a player with a long-range item can shoot back: the archer stays
    const armed = testWorld((x) => {
      x.areas[0].actors = [{ actor: 'archer', weight: 5, min: 1, max: 2 }];
      x.player.startingItems.push({ item: 'wand' });
    });
    expect(playerReach(armed)).toBeGreaterThanOrEqual(hostileReach(armed.actors.find((a) => a.id === 'archer')!));
    expect(newPlayerFixes(armed).world.areas[0].actors[0].max).toBe(2);
    // a goal that needs the archer defeated keeps it
    const needed = crowded();
    needed.goal.win = { type: 'actor_defeated', actor: 'archer' };
    expect(newPlayerFixes(needed).world.areas[0].actors.find((e) => e.actor === 'archer')!.max).toBeGreaterThan(0);
  });

  it('scales healing consumables to a quarter of max hp, leaving side-effect heals and uniques alone', () => {
    const w = testWorld((x) => {
      x.player.stats.hp = 40;
    });
    const tonic = w.items.find((i) => i.id === 'tonic')!;
    expect(itemProfile(w, tonic).heal).toBe(6); // 15% of 40
    const r = newPlayerFixes(w);
    const after = r.world.items.find((i) => i.id === 'tonic')!;
    expect(itemProfile(r.world, after).heal).toBeGreaterThanOrEqual(40 * MIN_HEAL_SHARE - 0.5);
    expect(itemProfile(r.world, after).heal).toBeLessThanOrEqual(40 * MIN_HEAL_SHARE + 1.5);
    expect(r.changes.join(' ')).toMatch(/tonic 6→/);
    // a tiny heal (a side effect, under 10% of max hp) is not turned into a heal item
    const tiny = testWorld((x) => {
      x.player.stats.hp = 80;
    });
    expect(newPlayerFixes(tiny).world.items.find((i) => i.id === 'tonic')).toEqual(tiny.items.find((i) => i.id === 'tonic'));
  });

  it('is idempotent, and returns the same world when nothing needs fixing', () => {
    const once = newPlayerFixes(crowded()).world;
    const twice = newPlayerFixes(once);
    expect(twice.world).toBe(once);
    expect(twice.changes).toEqual(['no changes']);
  });

  it('every demo world already has a new-player-friendly first area and heals', () => {
    for (const f of readdirSync(WORLD_DIR).filter((x) => x.endsWith('.json')).sort()) {
      const w = loadFixture(f);
      expect(newPlayerFixes(w).changes, f).toEqual(['no changes']);
    }
  });

  it('tuneWorld applies the fixes before its first analysis (and can be told not to)', () => {
    const w = crowded();
    const r = tuneWorld(w, { seeds: 2, bots: ['explorer'], rounds: 0, confirm: false, fast: true });
    expect(r.history[0].changes.join(' ')).toMatch(/spawn table capped/);
    expect(tableMax(r.world)).toBeLessThanOrEqual(FIRST_AREA_MAX_HOSTILES.medium);
    const off = tuneWorld(w, { seeds: 2, bots: ['explorer'], rounds: 0, confirm: false, fast: true, newPlayer: false });
    expect(off.history[0].changes).toEqual([]);
    expect(tableMax(off.world)).toBe(10);
  });
});

describe('new-player gate', () => {
  const world = loadFixture('fixture-ship.json');
  const killer = world.actors.find((a) => a.faction === 'hostile')!;
  const res = (difficulty: 'gentle' | 'normal' | 'hard', won: number, runs: number, bot = 'newbie'): SimResult[] =>
    Array.from({ length: runs }, (_, i) => ({
      world: world.meta.title,
      seed: i + 1,
      bot,
      difficulty,
      result: i < won ? 'won' : 'lost',
      turns: 100,
      steps: 100,
      areaReached: i < won ? world.areas.length - 1 : 0,
      cause: i < won ? 'won' : `killed by ${killer.name}`,
      stats: {} as SimResult['stats'],
      anomalies: [],
    }));

  it('floors: gentle 50%, normal 25%', () => {
    expect(NEW_PLAYER_GATE).toEqual({ gentle: 0.5, normal: 0.25 });
  });

  it('passes at the floors and fails below either one', () => {
    const pass = gateFromResults(world, [...res('gentle', 20, 40), ...res('normal', 10, 40)]);
    expect(pass.pass).toBe(true);
    expect(pass.levels.map((l) => l.pass)).toEqual([true, true]);
    const fail = gateFromResults(world, [...res('gentle', 30, 40), ...res('normal', 9, 40)]);
    expect(fail.pass).toBe(false);
    const normal = fail.levels.find((l) => l.difficulty === 'normal')!;
    expect(normal.pass).toBe(false);
    expect(normal.winRate).toBeCloseTo(9 / 40);
    expect(normal.topKiller).toBe(killer.name);
    expect(normal.firstAreaDeaths).toBeCloseTo(31 / 40);
    expect(formatGate(fail)).toMatch(/FAIL/);
  });

  it('a newbie clearly below the floor makes the verdict too_hard, even with the explorer in band', () => {
    expect(NEW_PLAYER_GATE).toBe(NEW_PLAYER_FLOORS);
    const sa = { ...staticAnalysis(world), issues: [] };
    const explorer = res('normal', 20, 40, 'explorer');
    const weak = summarize([...explorer, ...res('normal', 3, 40)], world.areas.length);
    const v = verdictFor(world, sa, weak, 'normal');
    expect(v.verdict).toBe('too_hard');
    expect(v.reasons.join(' ')).toMatch(/newbie wins 8%.*floor 25%/);
    expect(v.suggestions.join(' ')).toContain(killer.name);
    // near the floor (noise) it stays ok; hard / brutal have no floor
    expect(verdictFor(world, sa, summarize([...explorer, ...res('normal', 8, 40)], world.areas.length), 'normal').verdict).toBe('ok');
    const hard = summarize([...res('hard', 10, 40, 'explorer'), ...res('hard', 0, 40)], world.areas.length);
    expect(verdictFor(world, sa, hard, 'hard').verdict).toBe('ok');
  });

  it('only counts the newbie bot, and a level with no runs fails', () => {
    const g = gateFromResults(world, [...res('gentle', 40, 40, 'explorer'), ...res('normal', 40, 40)]);
    expect(g.levels.find((l) => l.difficulty === 'gentle')).toMatchObject({ runs: 0, pass: false });
    expect(g.pass).toBe(false);
  });
});

describe('tools/sim.ts --gate', () => {
  it('plays the newbie bot at gentle and normal and reports the gate per world', { timeout: 120_000 }, () => {
    const root = join(__dirname, '..', '..');
    const r = spawnSync('npx', ['tsx', 'tools/sim.ts', '--gate', '--json', '--jobs', '1', '--seeds', '2', '--max-turns', '400', '--world', 'content/worlds/fixture-teen.json'], { cwd: root, encoding: 'utf8' });
    // exit code 1 only means a world missed a floor (2 short games prove nothing either way)
    expect([0, 1], r.stderr).toContain(r.status);
    const out = JSON.parse(r.stdout);
    expect(out.runs).toBe(4);
    const g = out.worlds[0].gate;
    expect(g.levels.map((l: { difficulty: string; runs: number }) => [l.difficulty, l.runs])).toEqual([
      ['gentle', 2],
      ['normal', 2],
    ]);
    expect(r.status).toBe(g.pass ? 0 : 1);
  });
});
