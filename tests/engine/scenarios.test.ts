import { describe, it, expect } from 'vitest';
import { testWorld, newGame, ctxFor, player, addActor, act, env, roomMap, loadFixture } from './helpers';
import { createGame, describeActor, legalActions, step } from '../../src/engine';
import { dealDamage } from '../../src/engine/combat';
import { giveItem } from '../../src/engine/inventory';
import type { WorldSpecInput } from '../../src/schema';

const SELF = { shape: 'self', affects: 'self_only' } as const;
const counterTrigger = (on: string, counter: string) => ({ on, action: { targeting: SELF, effects: [{ type: 'counter', counter, add: 1 }] } });

describe('trigger events', () => {
  it('player triggers: on_hit, on_kill, on_hurt, on_enter_tile, on_area_enter, on_pickup', () => {
    const w = testWorld((x: WorldSpecInput) => {
      x.rules = [
        { id: 'watch', name: 'Watch', description: 'd', playerTriggers: ['on_hit', 'on_kill', 'on_hurt'].map((on) => counterTrigger(on, on)) as never },
        { id: 'walk', name: 'Walk', description: 'd', playerTriggers: ['on_enter_tile', 'on_area_enter'].map((on) => counterTrigger(on, on)) as never },
      ];
      x.items.find((i) => i.id === 'key')!.triggers = [counterTrigger('on_pickup', 'picked') as never];
    });
    let s = newGame(w);
    expect(s.counters.on_area_enter).toBe(1);
    s = act(w, s, { type: 'move', dir: 'e' }).state;
    expect(s.counters.on_enter_tile).toBe(1);
    const rat = addActor(w, s, 'rat', { x: 3, y: 1 }, { hp: 1 });
    for (let i = 0; i < 30 && s.area.actors.some((a) => a.id === rat.id); i++) s = act(w, s, { type: 'attack', targetId: rat.id }).state;
    expect(s.counters.on_hit).toBeGreaterThanOrEqual(1);
    expect(s.counters.on_kill).toBe(1);
    dealDamage(ctxFor(w, s), player(s), 2, 'physical');
    expect(s.counters.on_hurt).toBe(1);
    giveItem(ctxFor(w, s), 'key', 1);
    expect(s.counters.picked).toBe(1);
  });

  it('actor triggers: on_death and on_turn', () => {
    const w = testWorld((x: WorldSpecInput) => {
      x.actors[0].triggers = [counterTrigger('on_turn', 'ratturn') as never, counterTrigger('on_death', 'ratdeath') as never];
    });
    let s = newGame(w);
    const rat = addActor(w, s, 'rat', { x: 8, y: 8 });
    s = act(w, s, { type: 'wait' }).state;
    s = act(w, s, { type: 'wait' }).state;
    expect(s.counters.ratturn).toBe(2);
    const r = s.area.actors.find((a) => a.id === rat.id)!;
    dealDamage(ctxFor(w, s), r, 99, 'physical', player(s).id);
    expect(s.counters.ratdeath).toBe(1);
  });

  it('on_unequip fires', () => {
    const w = testWorld((x: WorldSpecInput) => {
      x.items.find((i) => i.id === 'stick')!.triggers = [counterTrigger('on_unequip', 'off') as never];
    });
    const s = act(w, newGame(w), { type: 'unequip', slot: 0 }).state;
    expect(s.counters.off).toBe(1);
  });
});

describe('map interaction', () => {
  it('doors open on bump, block sight while closed, and can be closed again', () => {
    const w = testWorld();
    const map = roomMap(12, 5, { walls: [{ x: 4, y: 1 }, { x: 4, y: 3 }] });
    map.tiles[2 * map.width + 4] = { kind: 'door' };
    let s = newGame(w, 1, map);
    s = act(w, s, { type: 'move', dir: 'se' }).state;
    s = act(w, s, { type: 'move', dir: 'e' }).state;
    s = act(w, s, { type: 'move', dir: 'e' }).state; // bump: opens
    expect(s.area.map.tiles[2 * map.width + 4].kind).toBe('door_open');
    expect(player(s).pos).toEqual({ x: 3, y: 2 });
    expect(s.area.seen[2 * map.width + 6]).toBe(2);
    s = act(w, s, { type: 'interact', pos: { x: 4, y: 2 } }).state;
    expect(s.area.map.tiles[2 * map.width + 4].kind).toBe('door');
    expect(s.area.seen[2 * map.width + 6]).toBe(1);
  });

  it('region_discovered fires for newly seen regions', () => {
    const w = testWorld();
    const map = roomMap(14, 6, { walls: [1, 2, 3, 4].map((y) => ({ x: 6, y })) });
    for (let y = 1; y < 5; y++) for (let x = 7; x < 13; x++) map.tiles[y * 14 + x].region = 1;
    map.tiles[3 * 14 + 6] = { kind: 'door' };
    map.regions.push({ id: 1, name: 'East', centre: { x: 10, y: 2 }, size: 24 });
    let s = newGame(w, 1, map);
    expect(s.area.discoveredRegions).toEqual([0]);
    let found = false;
    for (let i = 0; i < 8 && !found; i++) {
      const r = act(w, s, { type: 'move', dir: i < 2 ? 'se' : 'e' });
      found = r.events.some((e) => e.type === 'region_discovered' && e.regionId === 1);
      s = r.state;
    }
    expect(found).toBe(true);
  });
});

describe('describeActor', () => {
  it('reports faction, statuses, npc flag and a threat estimate', () => {
    const w = testWorld();
    const s = newGame(w);
    const g = addActor(w, s, 'golem', { x: 5, y: 5 }, { statuses: [{ id: 'burning', turnsLeft: 2 }] });
    const r = addActor(w, s, 'rat', { x: 6, y: 5 });
    const sage = addActor(w, s, 'sage', { x: 7, y: 5 });
    const gv = describeActor(s, g.id, env(w));
    expect(gv).toMatchObject({ name: 'Golem', faction: 'hostile', statuses: ['Burning'], isNpc: false, hp: 40, maxHp: 40 });
    expect(['dangerous', 'deadly']).toContain(gv.threat);
    expect(describeActor(s, r.id, env(w)).threat).toBe('trivial');
    expect(describeActor(s, sage.id, env(w))).toMatchObject({ isNpc: true, faction: 'friendly', threat: 'trivial' });
    expect(describeActor(s, player(s).id, env(w))).toMatchObject({ name: 'Tess', faction: 'player' });
  });
});

describe('fixture worlds', () => {
  it('western: defeating the broker while holding the jar wins', () => {
    const w = loadFixture('fixture-western.json');
    const s = createGame(w, { seed: 1 });
    s.defeated['absalom-vane'] = 1;
    giveItem(ctxFor(w, s), 'thunder-jar', 1);
    const r = step(s, { type: 'wait' }, { world: w });
    expect(r.state.status).toBe('won');
    expect(r.events.some((e) => e.type === 'game_over' && e.result === 'won')).toBe(true);
  });

  it('teen: three detention slips lose; Rosalind turns friendly at low composure and drops the notebook', () => {
    const w = loadFixture('fixture-teen.json');
    const s = createGame(w, { seed: 2 });
    s.counters.detentions = 3;
    expect(step(s, { type: 'wait' }, { world: w }).state.status).toBe('lost');
    const s2 = createGame(w, { seed: 2 });
    const ctx = ctxFor(w, s2);
    const free = s2.area.map.tiles.findIndex((t, i) => t.kind === 'floor' && !s2.area.actors.some((a) => a.pos.y * s2.area.map.width + a.pos.x === i));
    const pos = { x: free % s2.area.map.width, y: Math.floor(free / s2.area.map.width) };
    const ros = addActor(w, s2, 'rosalind', pos);
    dealDamage(ctx, ros, ros.maxHp - 3, 'physical', player(s2).id);
    expect(ros.faction).toBe('friendly');
    expect(s2.area.items.some((i) => i.item.defId === 'speech-notebook')).toBe(true);
    expect(s2.log.some((l) => l.text.startsWith("Rosalind's voice cracks"))).toBe(true);
  });

  it('ship: oxygen drains every turn and the arrival-log pickup sets its flag', () => {
    const w = loadFixture('fixture-ship.json');
    let s = createGame(w, { seed: 3 });
    const o2 = s.player.resources.oxygen;
    s = step(s, { type: 'wait' }, { world: w }).state;
    expect(s.player.resources.oxygen).toBe(o2 - 1);
    giveItem(ctxFor(w, s), 'arrival-log', 1);
    expect(s.flags['has-arrival-log']).toBe(true);
    expect(legalActions(s, { world: w }).length).toBeGreaterThan(0);
  });
});
