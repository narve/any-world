/**
 * M5 engine fixes:
 * - issues/M5-ranged-reach-metric.md: "reaches 5 tiles" means 5 steps in any direction (Chebyshev,
 *   like movement and ability targeting), not the round sight circle.
 * - issues/M5-actor-cap-per-area.md: summons and spawns stop at MAX_AREA_ACTORS living non-player
 *   actors, so a self-summoning actor cannot fill the map; worldWarnings flags the summon loop.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyGmActions, legalActions, step, leadPlayer } from '../../src/engine';
import { attackOf, inAttackRange } from '../../src/engine/combat';
import { withinRadius, withinReach } from '../../src/engine/fov';
import { giveItem } from '../../src/engine/inventory';
import { MAX_AREA_ACTORS, livingNonPlayerActors, spawnActor } from '../../src/engine/actors';
import { runGame } from '../../src/engine/sim/index';
import { parseWorld, worldWarnings } from '../../src/schema/refs';
import { addActor, ctxFor, env, newGame, player, roomMap, testWorld } from './helpers';

describe('ranged reach counts steps (Chebyshev), like movement', () => {
  it('withinReach: a foe 4 steps away diagonally is inside a 5-tile reach; 6 steps is not', () => {
    expect(withinReach({ x: 0, y: 0 }, { x: 4, y: 4 }, 5)).toBe(true);
    expect(withinReach({ x: 0, y: 0 }, { x: -4, y: 4 }, 5)).toBe(true);
    expect(withinReach({ x: 0, y: 0 }, { x: 5, y: 5 }, 5)).toBe(true);
    expect(withinReach({ x: 0, y: 0 }, { x: 6, y: 1 }, 5)).toBe(false);
    expect(withinReach({ x: 0, y: 0 }, { x: 1, y: 1 }, 0)).toBe(false);
    // sight stays round: the same tile is outside a 5 circle
    expect(withinRadius({ x: 0, y: 0 }, { x: 4, y: 4 }, 5)).toBe(false);
  });

  it('the player can shoot a visible hostile 4 steps away diagonally with a 5-tile weapon', () => {
    const world = testWorld((w) => {
      const bow = (w.items as { id: string; weapon?: { range: number } }[]).find((i) => i.id === 'bow')!;
      bow.weapon!.range = 5;
    });
    const s = newGame(world, 1, roomMap(20, 20, { start: { x: 10, y: 10 }, exit: { x: 18, y: 18 } }));
    const ctx = ctxFor(world, s);
    giveItem(ctx, 'bow', 1);
    leadPlayer(s).equipped.weapon = leadPlayer(s).slots.findIndex((x) => x?.defId === 'bow');
    const atk = attackOf(ctx, player(s))!.attack;
    expect(atk.range).toBe(5);
    const foe = addActor(world, s, 'rat', { x: 6, y: 6 });
    const far = addActor(world, s, 'rat', { x: 16, y: 10 });
    expect(inAttackRange(ctx, player(s), foe, atk)).toBe(true);
    expect(inAttackRange(ctx, player(s), far, atk)).toBe(false);
    // the legal-action list (what the client offers) agrees
    const st = step(s, { type: 'wait' }, env(world)).state;
    const foeNow = st.area.actors.find((a) => a.id === foe.id)!;
    if (Math.max(Math.abs(foeNow.pos.x - 10), Math.abs(foeNow.pos.y - 10)) <= 5) {
      expect(legalActions(st, env(world)).some((a) => a.type === 'attack' && a.targetId === foe.id)).toBe(true);
    }
  });
});

describe('actor cap per area', () => {
  /** fixture-western with dust-coyote neutral and summoning itself (chance, count) every turn */
  function spreadingWorld(chance: number, count: number) {
    const w = JSON.parse(readFileSync('content/worlds/fixture-western.json', 'utf8'));
    const a = w.actors.find((x: { id: string }) => x.id === 'dust-coyote');
    a.faction = 'neutral';
    a.triggers = [...(a.triggers ?? []), { on: 'on_turn', chance, action: { effects: [{ type: 'summon', actor: a.id, count }] } }];
    const r = parseWorld(w);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return r.world;
  }

  it('a self-summoning actor with a low chance does not fill the area (review r3 repro)', () => {
    const world = spreadingWorld(0.03, 1);
    let maxActors = 0;
    runGame(world, 1, 'explorer', { maxTurns: 400, fast: true, invariants: false, onStep: (s) => (maxActors = Math.max(maxActors, s.area.actors.length)) });
    expect(maxActors).toBeLessThan(150);
    // living non-player actors + the player (+ a few corpses at most) never pass the cap
    expect(maxActors).toBeLessThanOrEqual(MAX_AREA_ACTORS + 1 + 10);
  }, 120_000);

  it('the swarm (chance 1, count 4) stays capped and a 300-turn run finishes quickly', () => {
    const world = spreadingWorld(1, 4);
    let maxLiving = 0;
    const t0 = Date.now();
    runGame(world, 2, 'explorer', {
      maxTurns: 300,
      fast: true,
      invariants: false,
      onStep: (s) => (maxLiving = Math.max(maxLiving, s.area.actors.filter((a) => a.hp > 0 && a.id !== leadPlayer(s).actorId).length)),
    });
    expect(maxLiving).toBeLessThanOrEqual(MAX_AREA_ACTORS);
    expect(maxLiving).toBeGreaterThan(20); // it did swarm, up to the cap
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it('spawnActor refuses past the cap, except for the area placement (uncapped)', () => {
    const world = testWorld();
    const s = newGame(world, 1, roomMap(30, 30, { start: { x: 1, y: 1 }, exit: { x: 28, y: 28 } }));
    const ctx = ctxFor(world, s);
    let placed = 0;
    for (let y = 3; y < 28 && placed < MAX_AREA_ACTORS + 5; y++) {
      for (let x = 3; x < 28 && placed < MAX_AREA_ACTORS + 5; x++) if (spawnActor(ctx, 'rat', { x, y })) placed++;
    }
    expect(placed).toBe(MAX_AREA_ACTORS - (livingNonPlayerActors(ctx) - placed));
    expect(livingNonPlayerActors(ctx)).toBe(MAX_AREA_ACTORS);
    expect(spawnActor(ctx, 'rat', { x: 2, y: 27 })).toBeNull();
    expect(spawnActor(ctx, 'rat', { x: 2, y: 27 }, { uncapped: true })).not.toBeNull();
    // defeated actors free their places (61 living after the uncapped one: two must fall)
    for (const r of s.area.actors.filter((a) => a.defId === 'rat').slice(0, 2)) r.hp = 0;
    expect(livingNonPlayerActors(ctx)).toBe(MAX_AREA_ACTORS - 1);
    expect(spawnActor(ctx, 'rat', { x: 2, y: 26 })).not.toBeNull();
  });

  it('a GM spawn into a full area is rejected with a reason, not silently placed', () => {
    const world = testWorld();
    const s = newGame(world, 1, roomMap(30, 30, { start: { x: 1, y: 1 }, exit: { x: 28, y: 28 } }));
    for (let i = 0; i < MAX_AREA_ACTORS; i++) addActor(world, s, 'rat', { x: 3 + (i % 20), y: 3 + Math.floor(i / 20) });
    const before = s.area.actors.length;
    const r = applyGmActions(s, [{ type: 'spawn', actor: 'rat', count: 2, near: 'random' }] as never, env(world));
    expect(r.state.area.actors.length).toBe(before);
    expect(JSON.stringify(r)).toMatch(/area is full/);
  });

  it('worldWarnings flags an actor that summons its own kind (directly or round a loop)', () => {
    expect(worldWarnings(spreadingWorld(0.03, 1))).toEqual([expect.stringMatching(/actors\.dust-coyote: summons its own kind/)]);
    const loop = testWorld((w) => {
      const acts = w.actors as { id: string; abilities?: unknown[]; triggers?: unknown[] }[];
      acts.find((a) => a.id === 'rat')!.triggers = [{ on: 'on_hurt', action: { effects: [{ type: 'summon', actor: 'golem', count: 1 }] } }];
      acts.find((a) => a.id === 'golem')!.triggers = [{ on: 'on_turn', chance: 0.1, action: { effects: [{ type: 'summon', actor: 'rat', count: 1 }] } }];
    });
    const ws = worldWarnings(loop);
    expect(ws).toEqual(expect.arrayContaining([expect.stringMatching(/actors\.rat: summons its own kind through another actor/), expect.stringMatching(/actors\.golem/)]));
    // a one-off split on death is not a runaway loop
    const split = testWorld((w) => {
      const acts = w.actors as { id: string; triggers?: unknown[] }[];
      acts.find((a) => a.id === 'rat')!.triggers = [{ on: 'on_death', action: { effects: [{ type: 'summon', actor: 'rat', count: 2 }] } }];
    });
    expect(worldWarnings(split)).toEqual([]);
  });
});
