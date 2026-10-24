/**
 * issues/M2-sim-difficulty-not-played.md: the simulator, analyseWorld/tuneWorld and the sim CLI
 * play their games at the requested difficulty (engine scaling included), not only judge them
 * against that difficulty's band.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadFixture } from '../engine/helpers';
import { runGame, runMany, summarize } from '../../src/engine/sim/run';
import { analyseWorld } from '../../src/engine/balance';

const root = resolve(__dirname, '../..');
const seeds = Array.from({ length: 12 }, (_, i) => i + 1);

describe('sim difficulty', () => {
  const teen = loadFixture('fixture-teen.json');

  it('runGame creates the game at RunOptions.difficulty', () => {
    let seen: string | undefined;
    const r = runGame(teen, 1, 'explorer', { fast: true, maxTurns: 30, onStep: (s) => (seen = s.difficulty) });
    expect(r.difficulty).toBe('normal');
    const b = runGame(teen, 1, 'explorer', { fast: true, maxTurns: 30, difficulty: 'brutal', onStep: (s) => (seen = s.difficulty) });
    expect(b.difficulty).toBe('brutal');
    expect(seen).toBe('brutal');
  });

  it('brutal games scale the hostiles, and analyseWorld plays at its difficulty', { timeout: 300_000 }, () => {
    // (a win-rate comparison needs ~100 seeds to be reliable; the engine scaling itself is exact)
    const hostileHp = (d: 'normal' | 'brutal') => {
      let total = 0;
      runGame(teen, 3, 'explorer', {
        fast: true,
        maxTurns: 1,
        difficulty: d,
        onStep: (s) => {
          if (!total) for (const a of s.area.actors) if (a.faction === 'hostile') total += a.maxHp;
        },
      });
      return total;
    };
    const n = hostileHp('normal');
    expect(n).toBeGreaterThan(0);
    expect(hostileHp('brutal') / n).toBeGreaterThan(1.2);
    const few = [1, 2, 3];
    const play = (d: 'normal' | 'brutal') => summarize(runMany(teen, { seeds: few, bots: ['explorer'], fast: true, maxTurns: 400, difficulty: d }), teen.areas.length)[0];
    const brutal = play('brutal');
    const normal = play('normal');
    expect([brutal.avgTurns, brutal.avgKills]).not.toEqual([normal.avgTurns, normal.avgKills]);
    const report = analyseWorld(teen, { seeds: few, bots: ['explorer'], fast: true, maxTurns: 400, difficulty: 'brutal' });
    expect(report.difficulty).toBe('brutal');
    expect([report.sims[0].won, report.sims[0].avgTurns, report.sims[0].avgKills]).toEqual([brutal.won, brutal.avgTurns, brutal.avgKills]);
  });

  it('the CLI plays --difficulty games', { timeout: 120_000 }, () => {
    const out = execFileSync('npx', ['tsx', 'tools/sim.ts', '--world', 'content/worlds/fixture-teen.json', '--seeds', '1', '--bots', 'explorer', '--jobs', '1', '--max-turns', '50', '--difficulty', 'brutal', '--json'], {
      cwd: root,
      stdio: 'pipe',
    });
    const json = JSON.parse(String(out)) as { worlds: { difficulty: unknown }[] };
    expect(json.worlds[0].difficulty).toBe('brutal');
  });
});
