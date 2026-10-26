/**
 * M5 DoD audit round 3 (DoD #3, no soft-locks): diagnostic of the sim's "stuck" runs.
 * Prints, for each stuck seed, where the player stands, the tiles of the way onward and the last actions.
 */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runGame } from '../../../src/engine/sim/index';
import { legalActions, leadPlayer } from '../../../src/engine/index';
import { parseWorld } from '../../../src/schema/refs';

const CASES: [string, number[]][] = [
  ['microscopic-root-nodule', [97, 100]],
  ['corporate-merger-kitchen', []],
];

it('stuck runs: way onward reachable?', () => {
  const out: string[] = [];
  for (const [file, seeds] of CASES) {
    const pr = parseWorld(JSON.parse(readFileSync(`content/worlds/${file}.json`, 'utf8'))); if (!pr.ok) throw new Error('invalid'); const world = pr.world;
    for (const seed of seeds) {
      const acts: string[] = [];
      let last: any = null;
      const r = runGame(world, seed, 'cautious', { maxTurns: 3000, onStep: (s, a) => { last = s; acts.push(JSON.stringify(a)); } });
      const s = last;
      const me = s.area.actors.find((a: any) => a.id === leadPlayer(s).actorId);
      const legal = legalActions(s).map((a: any) => a.type);
      const counts: Record<string, number> = {};
      for (const a of acts.slice(-400)) counts[a] = (counts[a] ?? 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const hostiles = s.area.actors.filter((a: any) => a.faction === 'hostile' || a.hostile).map((a: any) => `${a.defId}@${a.pos.x},${a.pos.y}`);
      out.push(`${file} seed ${seed}: ${r.result} ${(r as any).reason ?? (r as any).cause ?? ''} turn ${s.turn} hp ${me?.hp}/${me?.maxHp} pos ${me?.pos.x},${me?.pos.y} legal=${[...new Set(legal)].join(',')} hostiles=${hostiles.join(' ')} top=${JSON.stringify(top)}`);
    }
  }
  console.log(out.join('\n'));
  expect(out.length).toBeGreaterThan(0);
}, 300_000);
