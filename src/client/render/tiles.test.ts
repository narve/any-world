import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../schema/refs';
import type { WorldSpec } from '../../schema/world';
import type { AreaMap, AreaState, Tile } from '../../engine/types';
import { AreaView } from './tiles';
import { renderedWallHeight, MAX_WALL_HEIGHT, STUB_HEIGHT } from './surfaces';
import { cutawayTiles } from './cutaway';
import { ItemLayer } from './items';
import { ActorLayer } from './actors';

function loadWorld(name: string): WorldSpec {
  const res = parseWorld(JSON.parse(readFileSync(join(__dirname, `../../../content/worlds/${name}.json`), 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.world;
}

/**
 * 9×7 map:
 *   #########
 *   #S..D..T#    S start, D door, T transition
 *   #.~~#...#    ~ water, # wall
 *   #...#.L.#    L lamp tile
 *   #.p.#...#    p terrain
 *   #...+...#    + open door
 *   #########
 */
function testMap(terrainId: string): AreaMap {
  const rows = ['#########', '#S..D..T#', '#.~~#...#', '#...#.L.#', '#.p.#...#', '#...+...#', '#########'];
  const tiles: Tile[] = [];
  for (const r of rows)
    for (const ch of r) {
      const t: Tile =
        ch === '#' ? { kind: 'wall' } : ch === 'S' ? { kind: 'start' } : ch === 'T' ? { kind: 'transition' } : ch === 'D' ? { kind: 'door' } : ch === '+' ? { kind: 'door_open' } : ch === '~' ? { kind: 'water' } : { kind: 'floor' };
      if (ch === 'L') t.lamp = true;
      if (ch === 'p') t.terrain = terrainId;
      tiles.push(t);
    }
  return { width: 9, height: 7, tiles, start: { x: 1, y: 1 }, exit: { x: 7, y: 1 }, regions: [] };
}

function area(map: AreaMap, seen: number[]): AreaState {
  return { index: 0, map, actors: [], items: [], seen, discoveredRegions: [], gmBudget: 0 };
}

const idx = (x: number, y: number) => y * 9 + x;

describe('AreaView', () => {
  const world = loadWorld('fixture-western');
  const plan = world.areas[0];
  const terrain = world.terrains.find((t) => !t.model && t.height > 0.1)!;

  it('builds instanced floors, walls, water, doors, transition and lamps', () => {
    const seen = new Array(63).fill(2);
    const v = new AreaView(world, plan, area(testMap(terrain.id), seen));
    const names = v.group.children.map((c) => c.name);
    expect(names).toContain('floor');
    expect(names).toContain('walls');
    expect(names).toContain('water');
    expect(names).toContain('transition');
    expect(v.lamps.length).toBe(1);
    expect(v.planWallHeight).toBe(plan.wall.height);
    expect(v.wallHeight).toBe(renderedWallHeight(plan.wall.height));
    expect(v.wallHeight).toBeLessThanOrEqual(MAX_WALL_HEIGHT);
    const walls = v.group.getObjectByName('walls') as THREE.InstancedMesh;
    expect(walls.count).toBeGreaterThan(20);
    const floors = v.group.getObjectByName('floor') as THREE.InstancedMesh;
    expect(floors.count).toBe(floorCount(testMap(terrain.id)));
    v.dispose();
  });

  it('applies fog of war: unseen hidden, remembered dimmed, visible lit', () => {
    const seen = new Array(63).fill(0);
    seen[idx(1, 1)] = 2;
    seen[idx(2, 1)] = 1;
    const v = new AreaView(world, plan, area(testMap(terrain.id), seen));
    const floors = v.group.getObjectByName('floor') as THREE.InstancedMesh;
    const of = (v as unknown as { floor: { of: Map<number, number> } }).floor.of;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    floors.getMatrixAt(of.get(idx(3, 1))!, m);
    expect(m.elements[0]).toBe(0); // unseen → zero scale
    floors.getMatrixAt(of.get(idx(1, 1))!, m);
    expect(m.elements[0]).toBeCloseTo(1);
    floors.getColorAt(of.get(idx(1, 1))!, c);
    const lit = c.r;
    floors.getColorAt(of.get(idx(2, 1))!, c);
    expect(c.r).toBeLessThan(lit * 0.6);
    expect(v.isVisible(1, 1)).toBe(true);
    expect(v.isVisible(2, 1)).toBe(false);
    // transition hidden until seen, then shown
    const tr = v.group.getObjectByName('transition')!;
    expect(tr.visible).toBe(false);
    seen[idx(7, 1)] = 2;
    v.applySeen(seen);
    expect(tr.visible).toBe(true);
    v.dispose();
  });

  it('lowers walls in the cut-away wedge and restores them', () => {
    const seen = new Array(63).fill(2);
    const v = new AreaView(world, plan, area(testMap(terrain.id), seen));
    const set = cutawayTiles({ width: 9, height: 7, isTall: (i) => v.isTall(i) }, { x: 2, y: 5 }, 0, { depth: 2 });
    expect(set.has(idx(2, 6))).toBe(true);
    v.setCutaway(set);
    // a low stub (STUB_HEIGHT tiles), not a flat slab
    expect(v.inspect(idx(2, 6)).wallScale * v.wallHeight).toBeCloseTo(STUB_HEIGHT);
    expect(v.inspect(idx(2, 0)).wallScale).toBe(1);
    v.setCutaway(new Set());
    expect(v.inspect(idx(2, 6)).wallScale).toBe(1);
    v.dispose();
  });

  // M1 issue: door frames and the transition model hid the player standing on / behind them
  it('treats door frames and the transition model as tall and flattens them in the cut-away', () => {
    const seen = new Array(63).fill(2);
    const v = new AreaView(world, plan, area(testMap(terrain.id), seen));
    const door = idx(4, 5);
    expect(v.isTall(door)).toBe(true);
    expect(v.isTall(idx(4, 1))).toBe(true);
    expect(v.isTall(idx(3, 5))).toBe(false);
    // player standing in the open doorway (camera south): the door frame on their tile is lowered
    const set = cutawayTiles({ width: 9, height: 7, isTall: (i) => v.isTall(i) }, { x: 4, y: 5 }, 0, { depth: 2 });
    expect(set.has(door)).toBe(true);
    v.setCutaway(set);
    expect(v.propScaleY(door)).toBeLessThan(0.3);
    v.setCutaway(new Set());
    expect(v.propScaleY(door)).toBe(1);
    // player north of the closed door, camera rotated so the door lies between them and the camera
    const behind = cutawayTiles({ width: 9, height: 7, isTall: (i) => v.isTall(i) }, { x: 4, y: 0 }, 0, { depth: 2 });
    expect(behind.has(idx(4, 1))).toBe(true);
    if (plan.transitionModel) {
      const exit = idx(7, 1);
      expect(v.isTall(exit)).toBe(true);
      v.setCutaway(cutawayTiles({ width: 9, height: 7, isTall: (i) => v.isTall(i) }, { x: 7, y: 1 }, 0));
      expect(v.propScaleY(exit)).toBeLessThan(0.3);
      v.setCutaway(new Set());
      expect(v.propScaleY(exit)).toBe(1);
    }
    v.dispose();
  });

  it('opens doors in place and rebuilds terrain when it changes; reports structural changes', () => {
    const seen = new Array(63).fill(2);
    const map = testMap(terrain.id);
    const v = new AreaView(world, plan, area(map, seen));
    const next: AreaMap = structuredClone(map);
    next.tiles[idx(4, 1)].kind = 'door_open';
    next.tiles[idx(5, 3)].terrain = terrain.id;
    expect(v.updateTiles(next)).toBe(true);
    const layer = v.group.getObjectByName(`terrain:${terrain.id}`);
    expect(layer).toBeTruthy();
    expect((layer as THREE.InstancedMesh).count).toBe(2);
    const broken: AreaMap = structuredClone(next);
    broken.tiles[idx(5, 3)].kind = 'wall';
    expect(v.updateTiles(broken)).toBe(false);
    v.dispose();
  });

  it('instances static terrain models (merged by material) with fog colours', () => {
    const withModel = world.terrains.find((t) => t.model && (t.model.idle ?? 'bob') === 'none')!;
    const seen = new Array(63).fill(1);
    const v = new AreaView(world, plan, area(testMap(withModel.id), seen));
    const layers: THREE.InstancedMesh[] = [];
    v.group.traverse((o) => {
      if (o.name === `terrain:${withModel.id}`) layers.push(o as THREE.InstancedMesh);
    });
    expect(layers.length).toBeGreaterThan(0);
    const c = new THREE.Color();
    layers[0].getColorAt(0, c);
    expect(c.r).toBeLessThan(0.5); // remembered → dimmed
    v.dispose();
  });

  it('clones animated terrain models per tile and dims them when remembered', () => {
    const base = world.terrains.find((t) => t.model)!;
    const animatedWorld: WorldSpec = { ...world, terrains: [{ ...base, id: 'anim-terrain', model: { ...base.model!, idle: 'sway' } }] };
    const seen = new Array(63).fill(1);
    const v = new AreaView(animatedWorld, plan, area(testMap('anim-terrain'), seen));
    let found: THREE.Object3D | null = null;
    v.group.traverse((o) => {
      if (o.userData.tile === idx(2, 4)) found = o;
    });
    expect(found).toBeTruthy();
    expect(found!.visible).toBe(true);
    let dim = false;
    found!.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && m.userData.dim) dim = true;
    });
    expect(dim).toBe(true);
    v.update(1.5, 0.016);
    v.dispose();
  });
});

function floorCount(map: AreaMap): number {
  return map.tiles.filter((t) => ['floor', 'start', 'door', 'door_open', 'transition'].includes(t.kind)).length;
}

describe('ItemLayer / ActorLayer', () => {
  const world = loadWorld('fixture-ship');

  it('tints unknown items by their appearance and hides items on non-visible tiles', () => {
    const unknown = world.items.find((i) => i.knowledge === 'unknown')!;
    const state = { knowledge: { [unknown.id]: { level: 'unknown', appearance: { label: 'x', color: '#ff00ff' }, notes: [], timesUsed: 0 } } } as never;
    expect(ItemLayer.tintFor(state, unknown.id)).toBe('#ff00ff');
    expect(ItemLayer.tintFor(state, 'nope')).toBeNull();
    const layer = new ItemLayer(world);
    const items = [
      { item: { id: 'i1', defId: unknown.id, count: 1 }, pos: { x: 1, y: 1 } },
      { item: { id: 'i2', defId: world.items[0].id, count: 1 }, pos: { x: 3, y: 1 } },
    ];
    layer.reconcile(items, state, (x) => x === 1, new Set());
    expect(layer.views.get('i1')!.root.visible).toBe(true);
    expect(layer.views.get('i2')!.root.visible).toBe(false);
    expect(layer.views.get('i1')!.tintKey).toBe('#ff00ff');
    const removed = layer.reconcile(items.slice(0, 1), state, () => true, new Set());
    expect(removed).toEqual(['i2']);
    layer.dispose();
  });

  it('creates actor views with faction rings and hp bars', () => {
    const layer = new ActorLayer(world);
    const base = { mp: 0, maxMp: 0, base: { str: 1, dex: 1, int: 1, ac: 1, speed: 100, sight: 5 }, statuses: [], energy: 0, cooldowns: {}, ai: { alerted: false }, tempMods: [] };
    const p = layer.ensure({ ...base, id: 'p', defId: 'player', pos: { x: 2, y: 3 }, hp: 10, maxHp: 10, faction: 'player' }, true);
    const h = layer.ensure({ ...base, id: 'a1', defId: world.actors[0].id, pos: { x: 4, y: 3 }, hp: 3, maxHp: 10, faction: 'hostile' }, false);
    expect(p.root.position.x).toBe(2);
    expect(p.root.position.z).toBe(3);
    expect(p.ringMat.color.getHexString()).not.toBe(h.ringMat.color.getHexString());
    expect(h.height).toBeGreaterThan(0.2);
    layer.setFaction(h, 'friendly');
    expect(h.faction).toBe('friendly');
    layer.setOpacity(h, 0.5);
    expect(h.fadeMats!.every((m) => m.opacity <= 0.5 + 1e-6)).toBe(true);
    layer.remove('a1');
    expect(layer.views.has('a1')).toBe(false);
    layer.dispose();
  });
});
