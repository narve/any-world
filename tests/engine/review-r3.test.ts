/**
 * Regression tests for the engine review round 3 (and the M1 playtest) issues fixed in M1:
 * perception symmetry, positional "only me" targeting, terrain statuses that never expire,
 * conditional interactions, transformed uniques, temporary terrain and "affects everyone" blasts.
 * See issues/M1-*.md for each issue.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, step, leadPlayer } from '../../src/engine';
import type { GameState, Pos } from '../../src/engine/types';
import { addActor, ctxFor, env, newGame, player, roomMap, testWorld } from './helpers';
import { dealDamage, inAttackRange } from '../../src/engine/combat';
import { spawnTerrain } from '../../src/engine/effects';
import { checkEnd } from '../../src/engine/turn';
import { spawnActor } from '../../src/engine/actors';
import { SeededRng } from '../../src/engine/rng';

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;
const selfT = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;

function slotOf(s: GameState, defId: string): number {
  return leadPlayer(s).slots.findIndex((it) => it?.defId === defId);
}

/** a world with a stationary shooter (range 6), like the western playtest's Claim Jumper */
function shooterWorld() {
  return testWorld((w) => {
    (w.actors as unknown[]).push({
      id: 'shooter',
      name: 'Shooter',
      description: 'takes potshots',
      stats: { hp: 10, ac: 10 },
      attack: { name: 'Shot', verb: 'takes a potshot at', damage: { base: 3 }, range: 6 },
      behaviour: { type: 'stationary' },
      sight: 10,
      xp: 1,
      model,
    });
  });
}

describe('perception symmetry: nobody attacks the player from a tile the player cannot see', () => {
  it('a range-6 shooter on a 6x6 diagonal (outside a sight-7 circle) never fires', () => {
    const world = shooterWorld();
    let s = newGame(world, 1, roomMap(30, 30, { start: { x: 20, y: 20 }, exit: { x: 27, y: 27 } }));
    // the player's base sight is at least 10 (playerBaseSight); a dimming modifier brings it to 7
    player(s).base.sight = 7;
    player(s).tempMods.push({ stat: 'sight', amount: -3, turnsLeft: 99 });
    addActor(world, s, 'shooter', { x: 14, y: 14 }, { ai: { alerted: true } });
    const hp = player(s).hp;
    for (let i = 0; i < 8; i++) s = step(s, { type: 'wait' }, env(world)).state;
    expect(player(s).hp).toBe(hp);
  });

  it('a shooter in range but beyond the player\'s (short) sight holds fire until it is seen', () => {
    const world = shooterWorld();
    const s = newGame(world, 1, roomMap(30, 30, { start: { x: 10, y: 10 }, exit: { x: 27, y: 27 } }));
    // base sight 3 plays as 10 (playerBaseSight); a dimming modifier brings it back to 3
    player(s).base.sight = 3;
    player(s).tempMods.push({ stat: 'sight', amount: -7, turnsLeft: 99 });
    const far = addActor(world, s, 'shooter', { x: 15, y: 10 }, { ai: { alerted: true } });
    const ctx = ctxFor(world, s);
    const atk = world.actors.find((a) => a.id === 'shooter')!.attack!;
    expect(inAttackRange(ctx, far, player(s), atk)).toBe(false);
    let st = s;
    const hp = player(st).hp;
    for (let i = 0; i < 6; i++) st = step(st, { type: 'wait' }, env(world)).state;
    expect(player(st).hp).toBe(hp);
    // the same shooter where the player can see it does fire
    far.pos = { x: 13, y: 10 };
    expect(inAttackRange(ctxFor(world, s), far, player(s), atk)).toBe(true);
  });

  it('property: every ranged hit on the player comes from a tile in the player\'s field of view', () => {
    let attacks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const world = shooterWorld();
      const rng = SeededRng.fromSeed(seed * 7919);
      const walls: Pos[] = [];
      for (let i = 0; i < 40; i++) walls.push({ x: rng.int(2, 26), y: rng.int(2, 18) });
      const map = roomMap(30, 22, { start: { x: 14, y: 10 }, exit: { x: 27, y: 19 }, walls: walls.filter((p) => !(p.x === 14 && p.y === 10)) });
      let s = newGame(world, seed, map);
      player(s).base.sight = 3 + (seed % 4);
      player(s).hp = player(s).maxHp = 500;
      const free = (p: Pos) => map.tiles[p.y * map.width + p.x].kind === 'floor' && !s.area.actors.some((a) => a.pos.x === p.x && p.y === a.pos.y);
      for (let k = 0; k < 6; k++) {
        const p = { x: rng.int(1, 28), y: rng.int(1, 20) };
        if (!free(p)) continue;
        addActor(world, s, k % 2 ? 'shooter' : 'archer', p, { ai: { alerted: true }, base: { str: 10, dex: 10, int: 10, ac: 10, speed: 100, sight: 12 } });
      }
      for (let turn = 0; turn < 40 && s.status === 'playing'; turn++) {
        const acts = legalActions(s, env(world)).filter((a) => a.type === 'move' || a.type === 'wait');
        const r = step(s, acts[rng.int(0, acts.length - 1)], env(world));
        const st = r.state;
        const pl = player(st);
        for (const e of r.events) {
          const attackerId = e.type === 'attacked' && e.targetId === pl.id ? e.attackerId : e.type === 'damaged' && e.actorId === pl.id ? e.sourceId : undefined;
          if (!attackerId) continue;
          const a = st.area.actors.find((x) => x.id === attackerId);
          if (!a) continue;
          attacks++;
          if (Math.max(Math.abs(a.pos.x - pl.pos.x), Math.abs(a.pos.y - pl.pos.y)) <= 1) continue;
          expect(leadPlayer(st).seen[a.pos.y * st.area.map.width + a.pos.x], `seed ${seed} turn ${turn}: hit from unseen ${a.defId}`).toBe(2);
        }
        s = st;
      }
    }
    expect(attacks).toBeGreaterThan(0);
  });
});

describe('positional "only me" items respect range, line of sight and the exit', () => {
  function blinkWorld(range: number, needsLos = true) {
    return testWorld((w) => {
      (w.items as unknown[]).push({
        id: 'blink',
        name: 'Blink Charm',
        kind: 'Charm',
        description: 'step a short way',
        category: 'tool',
        useMode: 'reusable',
        onUse: { targeting: { shape: 'single', range, affects: 'self_only', needsLos }, effects: [{ type: 'teleport', mode: 'to_target' }] },
        model,
      });
      (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'blink' });
    });
  }

  it('a positional item that only affects its user still respects its range and line of sight', () => {
    const world = blinkWorld(3);
    // a solid wall at x=10 splits the room; the far side is out of range and out of sight
    const walls = Array.from({ length: 8 }, (_, i) => ({ x: 10, y: i + 1 }));
    const s = newGame(world, 1, roomMap(20, 10, { walls, exit: { x: 3, y: 8 } }));
    const slot = slotOf(s, 'blink');
    const r = step(s, { type: 'use', slot, target: { x: 16, y: 5 } }, env(world));
    expect(player(r.state).pos).not.toEqual({ x: 16, y: 5 });
    expect(r.events.some((e) => e.type === 'invalid')).toBe(true);
  });

  it('a blink within range and sight still works', () => {
    const world = blinkWorld(3);
    const s = newGame(world);
    const r = step(s, { type: 'use', slot: slotOf(s, 'blink'), target: { x: 3, y: 3 } }, env(world));
    expect(player(r.state).pos).toEqual({ x: 3, y: 3 });
  });

  it('a long blink that ignores walls never lands in a pocket the exit cannot be reached from', () => {
    const world = blinkWorld(20, false);
    // a sealed 3x3 pocket around (15,5)
    const walls: Pos[] = [];
    for (let x = 13; x <= 17; x++) walls.push({ x, y: 3 }, { x, y: 7 });
    for (let y = 4; y <= 6; y++) walls.push({ x: 13, y }, { x: 17, y });
    const s = newGame(world, 1, roomMap(20, 10, { walls, exit: { x: 3, y: 8 } }));
    const r = step(s, { type: 'use', slot: slotOf(s, 'blink'), target: { x: 15, y: 5 } }, env(world));
    const p = player(r.state).pos;
    expect(p.x >= 14 && p.x <= 16 && p.y >= 4 && p.y <= 6).toBe(false);
  });
});

describe('terrain statuses always run out', () => {
  function terrainWorld(id: string, status: string, duration: number) {
    return testWorld((w) => {
      (w.terrains as unknown[]).push({ id, name: id, description: 'd', onStand: [{ type: 'apply_status', status, duration }], color: '#111111' });
    });
  }

  it('standing on terrain that stuns for 2 turns does not freeze the run for a thousand rounds', () => {
    const world = terrainWorld('tar', 'stun', 2);
    const map = roomMap();
    map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'tar' };
    const s = newGame(world, 1, map);
    const r = step(s, { type: 'move', dir: 'e' }, env(world));
    expect(r.state.turn - s.turn).toBeLessThanOrEqual(5);
    expect(player(r.state).statuses.some((st) => st.id === 'stun')).toBe(false);
  });

  it('terrain that roots for 2 (or 5) turns lets the player step off again', () => {
    for (const d of [2, 5]) {
      const world = terrainWorld('mire', 'root', d);
      const map = roomMap();
      map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'mire' };
      let s = newGame(world, 1, map);
      s = step(s, { type: 'move', dir: 'e' }, env(world)).state;
      let escaped = false;
      for (let i = 0; i < 12 && !escaped; i++) {
        const r = step(s, { type: 'move', dir: 'e' }, env(world));
        if (r.events.some((e) => e.type === 'invalid')) s = step(s, { type: 'wait' }, env(world)).state;
        else escaped = true;
      }
      expect(escaped).toBe(true);
    }
  });

  it('the terrain still applies its status while the actor stays (after it ran out)', () => {
    const world = terrainWorld('mire', 'root', 2);
    const map = roomMap();
    map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'mire' };
    let s = newGame(world, 1, map);
    s = step(s, { type: 'move', dir: 'e' }, env(world)).state;
    let rootedTurns = 0;
    for (let i = 0; i < 9; i++) {
      s = step(s, { type: 'wait' }, env(world)).state;
      if (player(s).statuses.some((st) => st.id === 'root')) rootedTurns++;
    }
    expect(rootedTurns).toBeGreaterThanOrEqual(5);
    expect(rootedTurns).toBeLessThan(9);
  });
});

describe('terrain interactions', () => {
  function boxWorld(condition: unknown) {
    return testWorld((w) => {
      (w.terrains as unknown[]).push({
        id: 'strongbox',
        name: 'Strongbox',
        description: 'locked tight',
        walkable: false,
        color: '#775500',
        interact: { targeting: selfT, condition, effects: [{ type: 'spawn_item', item: 'tonic' }] },
      });
    });
  }

  it('an interaction whose condition fails does not use up the tile', () => {
    const world = boxWorld({ type: 'has_item', who: 'player', item: 'key' });
    const map = roomMap();
    map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'strongbox' };
    let s = newGame(world, 1, map);
    s = step(s, { type: 'interact', pos: { x: 2, y: 1 } }, env(world)).state; // no key yet: nothing happens
    expect(legalActions(s, env(world)).some((a) => a.type === 'interact')).toBe(true);
    const slot = leadPlayer(s).slots.findIndex((x) => x === null);
    leadPlayer(s).slots[slot] = { id: 'i900', defId: 'key', count: 1 }; // the player finds the key
    const before = s.area.items.length;
    const r = step(s, { type: 'interact', pos: { x: 2, y: 1 } }, env(world));
    expect(r.events.find((e) => e.type === 'invalid')).toBeUndefined();
    expect(r.state.area.items.length).toBe(before + 1);
    // and now it is used up
    const again = step(r.state, { type: 'interact', pos: { x: 2, y: 1 } }, env(world));
    expect(again.events.some((e) => e.type === 'invalid')).toBe(true);
  });

  it('a pure luck roll is still one roll per tile', () => {
    const world = boxWorld({ type: 'chance', p: 0 });
    const map = roomMap();
    map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'strongbox' };
    let s = newGame(world, 1, map);
    s = step(s, { type: 'interact', pos: { x: 2, y: 1 } }, env(world)).state;
    const r = step(s, { type: 'interact', pos: { x: 2, y: 1 } }, env(world));
    expect(r.events.some((e) => e.type === 'invalid')).toBe(true);
  });
});

describe('temporary terrain', () => {
  it('temporary terrain restores the terrain it covered when it expires', () => {
    const world = testWorld();
    const map = roomMap();
    map.tiles[5 * map.width + 5] = { kind: 'floor', terrain: 'chest' };
    let s = newGame(world, 1, map);
    const ctx = ctxFor(world, s);
    expect(spawnTerrain(ctx, 'glue', { x: 5, y: 5 }, 0, 2)).toBe(1);
    s.rng = ctx.rng.state();
    for (let i = 0; i < 4; i++) s = step(s, { type: 'wait' }, env(world)).state;
    expect(s.area.map.tiles[5 * map.width + 5].terrain).toBe('chest');
    expect(s.area.map.tiles[5 * map.width + 5].terrainUnder).toBeUndefined();
  });

  it('layered temporary terrain restores the original, and a used chest stays used', () => {
    const world = testWorld();
    const map = roomMap();
    map.tiles[5 * map.width + 5] = { kind: 'floor', terrain: 'chest', interacted: true };
    let s = newGame(world, 1, map);
    const ctx = ctxFor(world, s);
    spawnTerrain(ctx, 'glue', { x: 5, y: 5 }, 0, 2);
    spawnTerrain(ctx, 'spikes', { x: 5, y: 5 }, 0, 3);
    s.rng = ctx.rng.state();
    for (let i = 0; i < 5; i++) s = step(s, { type: 'wait' }, env(world)).state;
    const t = s.area.map.tiles[5 * map.width + 5];
    expect(t.terrain).toBe('chest');
    expect(t.interacted).toBe(true);
  });

  it('a covered blocking terrain waits for the actor standing there to leave', () => {
    const world = testWorld();
    const map = roomMap();
    map.tiles[5 * map.width + 5] = { kind: 'floor', terrain: 'pillar' };
    let s = newGame(world, 1, map);
    const ctx = ctxFor(world, s);
    spawnTerrain(ctx, 'spikes', { x: 5, y: 5 }, 0, 1);
    s.rng = ctx.rng.state();
    const g = addActor(world, s, 'golem', { x: 5, y: 5 }); // stationary: never leaves
    s = step(s, { type: 'wait' }, env(world)).state;
    s = step(s, { type: 'wait' }, env(world)).state;
    expect(s.area.map.tiles[5 * map.width + 5].terrain).toBe('spikes');
    s.area.actors = s.area.actors.filter((a) => a.id !== g.id);
    s = step(s, { type: 'wait' }, env(world)).state;
    expect(s.area.map.tiles[5 * map.width + 5].terrain).toBe('pillar');
  });
});

describe('transformed uniques', () => {
  function phaseWorld() {
    return testWorld((w) => {
      const boss = (w.actors as { id: string; triggers?: unknown[] }[]).find((a) => a.id === 'boss')!;
      boss.triggers = [
        { on: 'on_low_hp', action: { targeting: selfT, effects: [{ type: 'transform', into: 'golem' }] } },
        { on: 'on_death', action: { targeting: selfT, effects: [{ type: 'set_flag', flag: 'boss-down' }] } },
      ];
    });
  }

  it('a unique that transforms (second phase) still counts as defeated when its new form falls', () => {
    const world = testWorld((w) => {
      const boss = (w.actors as { id: string; triggers?: unknown[] }[]).find((a) => a.id === 'boss')!;
      boss.triggers = [{ on: 'on_low_hp', action: { targeting: selfT, effects: [{ type: 'transform', into: 'golem' }] } }];
      w.goal.win = { type: 'actor_defeated', actor: 'boss' };
    });
    const s = newGame(world);
    const boss = addActor(world, s, 'boss', { x: 2, y: 1 });
    const ctx = ctxFor(world, s);
    dealDamage(ctx, boss, 15, 'physical', leadPlayer(s).actorId); // below 30%: the boss becomes its true form
    expect(boss.defId).toBe('golem');
    dealDamage(ctx, boss, 999, 'physical', leadPlayer(s).actorId); // the true form falls
    checkEnd(ctx);
    expect(ctx.s.status).toBe('won');
    expect(ctx.s.defeated.golem).toBe(1);
  });

  it("the original unique's on_death triggers fire, and no second copy spawns while its later form lives", () => {
    const world = phaseWorld();
    const s = newGame(world);
    const boss = addActor(world, s, 'boss', { x: 2, y: 1 });
    const ctx = ctxFor(world, s);
    dealDamage(ctx, boss, 15, 'physical', leadPlayer(s).actorId);
    expect(boss.defId).toBe('golem');
    expect(spawnActor(ctx, 'boss', { x: 6, y: 6 })).toBeNull();
    dealDamage(ctx, boss, 999, 'physical', leadPlayer(s).actorId);
    expect(ctx.s.flags['boss-down']).toBe(true);
    checkEnd(ctx);
    expect(ctx.s.status).toBe('won');
  });
});

describe('"affects everyone" auto-targeting', () => {
  function blastWorld(effects: unknown[]) {
    return testWorld((w) => {
      (w.items as unknown[]).push({
        id: 'blast',
        name: 'Blasting Stick',
        kind: 'Explosive',
        description: 'hurts everyone nearby',
        category: 'throwable',
        useMode: 'consumed',
        stackable: true,
        onUse: { targeting: { shape: 'area', range: 5, radius: 1, affects: 'all' }, effects },
        model,
      });
      (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'blast', count: 2 });
    });
  }

  it('an "affects everyone" blast with nothing in range does not auto-target the user', () => {
    const world = blastWorld([{ type: 'damage', amount: { base: 6 } }]);
    const s = newGame(world);
    const slot = slotOf(s, 'blast');
    const pos = player(s).pos;
    const offered = legalActions(s, env(world)).find((a) => a.type === 'use' && a.slot === slot);
    // a bot following legalActions must not be offered "throw it at your own feet"
    if (offered && offered.type === 'use') expect(offered.target).not.toEqual(pos);
    const r = step(s, { type: 'use', slot }, env(world));
    expect(player(r.state).hp).toBe(player(s).hp);
    expect(r.events.some((e) => e.type === 'invalid')).toBe(true);
  });

  it('with an enemy in range the blast aims at the enemy', () => {
    const world = blastWorld([{ type: 'damage', amount: { base: 6 } }]);
    const s = newGame(world);
    addActor(world, s, 'golem', { x: 5, y: 4 });
    const slot = slotOf(s, 'blast');
    const offered = legalActions(s, env(world)).find((a) => a.type === 'use' && a.slot === slot);
    expect(offered && offered.type === 'use' ? offered.target : null).toEqual({ x: 5, y: 4 });
  });

  it('a harmless "affects everyone" item (a healing mist) still falls back to its user', () => {
    const world = blastWorld([{ type: 'heal', amount: { base: 5 } }]);
    const s = newGame(world);
    player(s).hp -= 10;
    const r = step(s, { type: 'use', slot: slotOf(s, 'blast') }, env(world));
    expect(r.events.some((e) => e.type === 'invalid')).toBe(false);
    expect(player(r.state).hp).toBeGreaterThan(player(s).hp);
  });
});
