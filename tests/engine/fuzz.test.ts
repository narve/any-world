import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture, simpleGenerator } from './helpers';
import { createGame, step, legalActions, serialize, deserialize, describeItem, describeActor } from '../../src/engine';
import { generateArea } from '../../src/engine/mapgen/index';
import { createRng } from '../../src/engine/rng';
import type { MapGenerator, PlayerAction, GameState } from '../../src/engine/types';
import { TOTAL_SLOTS } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema';

function checkInvariants(world: WorldSpec, s: GameState): void {
  const map = s.area.map;
  expect(map.tiles.length).toBe(map.width * map.height);
  expect(s.player.slots).toHaveLength(TOTAL_SLOTS);
  const blocking = new Set(world.terrains.filter((t) => !t.walkable).map((t) => t.id));
  const taken = new Set<string>();
  for (const a of s.area.actors) {
    expect(Number.isFinite(a.hp) && Number.isFinite(a.energy)).toBe(true);
    if (a.hp <= 0) continue;
    const k = `${a.pos.x},${a.pos.y}`;
    expect(taken.has(k), `two actors on ${k}`).toBe(false);
    taken.add(k);
    const t = map.tiles[a.pos.y * map.width + a.pos.x];
    expect(t, `actor ${a.id} out of bounds`).toBeDefined();
    expect(['floor', 'door', 'door_open', 'start', 'transition']).toContain(t.kind);
    expect(t.terrain && blocking.has(t.terrain), `actor ${a.id} inside blocking terrain`).toBeFalsy();
  }
  if (s.status === 'playing') expect(s.area.actors.some((a) => a.id === s.player.actorId && a.hp > 0)).toBe(true);
  for (const k of ['weapon', 'armour', 'trinket'] as const) {
    const i = s.player.equipped[k];
    if (i !== null) expect(s.player.slots[i], `equipped ${k} points at empty slot`).not.toBeNull();
  }
  for (const it of s.player.slots) if (it) expect(it.count).toBeGreaterThan(0);
  for (const r of world.resources) {
    const v = s.player.resources[r.id];
    expect(v >= 0 && v <= r.max).toBe(true);
  }
  expect(s.rng).toHaveLength(4);
}

const files = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json')).sort();

/** real mapgen when it works, else the test generator */
function pickGenerator(): { gen: MapGenerator; name: string } {
  try {
    const w = loadFixture(files[0]);
    generateArea(w.areas[0], w, createRng(1));
    return { gen: generateArea, name: 'mapgen' };
  } catch {
    return { gen: simpleGenerator, name: 'test generator' };
  }
}

const { gen, name } = pickGenerator();

function randomJunk(rng: ReturnType<typeof createRng>, s: GameState): PlayerAction {
  const pick = rng.int(0, 6);
  const a = s.area.actors[rng.int(0, s.area.actors.length - 1)];
  switch (pick) {
    case 0: return { type: 'use', slot: rng.int(-2, 30), target: { x: rng.int(-1, 60), y: rng.int(-1, 60) } };
    case 1: return { type: 'attack', targetId: a?.id ?? 'nope' };
    case 2: return { type: 'move_item', from: rng.int(0, 27), to: rng.int(0, 27) };
    case 3: return { type: 'interact', pos: { x: rng.int(0, 60), y: rng.int(0, 60) } };
    case 4: return { type: 'choose_option', index: rng.int(-1, 4) };
    case 5: return { type: 'talk', targetId: a?.id ?? 'x' };
    default: return { type: 'transition' };
  }
}

describe(`500-turn random fuzz (${name})`, () => {
  for (const f of files) {
    for (const seed of [1, 2, 3]) {
      it(`${f} seed ${seed}: 500 random steps never throw`, () => {
        const world = loadFixture(f);
        const env = { world, mapGenerator: gen };
        let s = createGame(world, { seed, mapGenerator: gen });
        const rng = createRng(seed * 7919);
        let steps = 0;
        let maxArea = 0;
        let run = 0;
        for (let i = 0; i < 500; i++) {
          if (s.status !== 'playing') {
            // the random player died or won: keep fuzzing on a fresh run
            run++;
            s = createGame(world, { seed: seed * 1000 + run, mapGenerator: gen });
          }
          const legal = legalActions(s, env);
          expect(legal.length).toBeGreaterThan(0);
          // bias towards progress: transition when possible, pick up, otherwise random
          let action: PlayerAction;
          const tr = legal.find((a) => a.type === 'transition');
          if (tr && rng.chance(0.8)) action = tr;
          else if (rng.chance(0.1)) action = randomJunk(rng, s);
          else action = legal[rng.int(0, legal.length - 1)];
          const r = step(s, action, env);
          if (legal.includes(action)) expect(r.events.find((e) => e.type === 'invalid'), JSON.stringify(action)).toBeUndefined();
          s = r.state;
          checkInvariants(world, s);
          steps++;
          maxArea = Math.max(maxArea, s.area.index);
          if (i % 50 === 0) {
            for (const it of s.player.slots) if (it) describeItem(s, it.id, env);
            for (const a of s.area.actors) describeActor(s, a.id, env);
            const back = deserialize(world, serialize(s));
            expect(serialize(back)).toBe(serialize(s));
          }
        }
        expect(steps).toBeGreaterThan(0);
        void maxArea;
      });
    }
  }
});
