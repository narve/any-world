/**
 * Review M5 round 1: engine purity after the M3 copy-on-write clone (engine/clone.ts, ctx.mutTile),
 * fuzzed across every bundled world with random legal actions and random GM actions. Every input
 * state must serialize exactly as before its step / applyGmActions call, and every earlier state
 * must stay intact for the whole run.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseWorld } from '../../../src/schema/refs';
import { applyGmActions, createGame, legalActions, serialize, step } from '../../../src/engine';
import type { GameState } from '../../../src/engine/types';
import type { GmAction } from '../../../src/schema/gm';
import { createRng } from '../../../src/engine/rng';

const files = readdirSync('content/worlds').filter((f) => f.endsWith('.json'));

describe('engine purity fuzz across bundled worlds', () => {
  for (const f of files) {
    it(`${f}: no step or GM call mutates an earlier state`, () => {
      const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${f}`, 'utf8')));
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const world = r.world;
      const rng = createRng(f.length * 31 + 7);
      let s: GameState = createGame(world, { seed: 11 });
      const history: { s: GameState; json: string }[] = [];
      const terrains = world.terrains.map((t) => t.id);
      const items = world.items.map((i) => i.id);
      const actors = world.actors.filter((a) => !a.npc && !a.unique).map((a) => a.id);
      for (let i = 0; i < 250 && s.status === 'playing'; i++) {
        const json = serialize(s);
        history.push({ s, json });
        if (i % 9 === 4) {
          const gm: GmAction[] = [];
          if (terrains.length) gm.push({ type: 'effect', target: 'player', effects: [{ type: 'spawn_terrain', terrain: terrains[rng.int(0, terrains.length - 1)], radius: 1, duration: 3 } as never] });
          if (items.length) gm.push({ type: 'place_item', item: items[rng.int(0, items.length - 1)]!, near: 'player' });
          if (actors.length && rng.chance(0.3)) gm.push({ type: 'spawn', actor: actors[rng.int(0, actors.length - 1)]!, count: 1, near: 'random' });
          s = applyGmActions(s, gm, { world }).state;
        } else {
          const legal = legalActions(s, { world });
          const a = legal[rng.int(0, legal.length - 1)]!;
          s = step(s, a, { world }).state;
        }
        expect(serialize(history[history.length - 1]!.s)).toBe(json);
      }
      for (const h of history) expect(serialize(h.s)).toBe(h.json);
    }, 60_000);
  }
});
