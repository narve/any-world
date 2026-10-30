import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../schema/refs';
import type { WorldSpec, AreaPlan } from '../../schema/world';
import type { AreaMap, AreaState, Tile } from '../../engine/types';
import { AreaView, type FoggedArea } from './tiles';
import { ActorLayer, actorScaleFor, lowContrast, MIN_ACTOR_HEIGHT, ACTOR_SCALE } from './actors';
import { Backdrop, backdropParams, backdropHorizonColor, BACKDROP_STYLES } from './backdrop';
import { defaultDistance, DEFAULT_HALF_WIDTH, CAMERA_FOV_DEG, CameraRig, MAX_DIST, MIN_DIST } from './camera';
import { luminance } from './color';
import {
  wallStyleFor,
  renderedWallHeight,
  wallProfile,
  isLiquidTerrain,
  patchAlpha,
  PatchLayer,
  MAX_WALL_HEIGHT,
  PROFILE_FAR,
  STUB_HEIGHT,
  floatsOverVoid,
} from './surfaces';

function loadWorld(name: string): WorldSpec {
  const res = parseWorld(JSON.parse(readFileSync(join(__dirname, `../../../content/worlds/${name}.json`), 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.world;
}

function mapFrom(rows: string[]): AreaMap {
  const tiles: Tile[] = [];
  for (const r of rows)
    for (const ch of r)
      tiles.push(
        ch === '#' ? { kind: 'wall' } : ch === ' ' ? { kind: 'void' } : ch === '~' ? { kind: 'water' } : ch === 'S' ? { kind: 'start' } : ch === 'T' ? { kind: 'transition' } : { kind: 'floor', terrain: ch === 'w' ? 'flood' : undefined },
      );
  const W = rows[0].length;
  const s = tiles.findIndex((t) => t.kind === 'start');
  const e = tiles.findIndex((t) => t.kind === 'transition');
  return { width: W, height: rows.length, tiles, start: { x: s % W, y: Math.floor(s / W) }, exit: { x: e % W, y: Math.floor(e / W) }, regions: [] };
}

const area = (map: AreaMap): FoggedArea => ({ index: 0, map, actors: [], items: [], seen: new Array(map.tiles.length).fill(2), discoveredRegions: [], gmBudget: 0 });

describe('surface rules', () => {
  it('picks a wall look per layout family', () => {
    expect(wallStyleFor('organic')).toBe('blob');
    expect(wallStyleFor('geometric')).toBe('crisp');
    expect(wallStyleFor('caves')).toBe('rough');
    expect(wallStyleFor('ship')).toBe('box');
    expect(floatsOverVoid('islands')).toBe(true);
    expect(floatsOverVoid('town')).toBe(false);
  });

  it('clamps rendered wall height and keeps low walls low', () => {
    expect(renderedWallHeight(2.6)).toBe(MAX_WALL_HEIGHT);
    expect(renderedWallHeight(1.8)).toBe(MAX_WALL_HEIGHT);
    expect(renderedWallHeight(0.6)).toBe(0.6);
    expect(renderedWallHeight(undefined)).toBeLessThanOrEqual(1.2);
    expect(MAX_WALL_HEIGHT).toBeGreaterThanOrEqual(1);
    expect(MAX_WALL_HEIGHT).toBeLessThanOrEqual(1.2);
  });

  it('lowers walls more than two rows in front of / behind the player', () => {
    expect(wallProfile(0)).toBe(1);
    expect(wallProfile(1)).toBe(1);
    expect(wallProfile(-2)).toBe(1);
    expect(wallProfile(2)).toBe(PROFILE_FAR);
    expect(wallProfile(-3)).toBe(PROFILE_FAR);
    expect(wallProfile(-8)).toBe(PROFILE_FAR);
    expect(PROFILE_FAR).toBeCloseTo(0.7);
  });

  it('recognises liquid terrain by its words, only when flat', () => {
    expect(isLiquidTerrain({ id: 'seep-water', name: 'Reservoir Seep', height: 0 })).toBe(true);
    expect(isLiquidTerrain({ id: 'coolant-leak', name: 'Coolant Leak', height: 0.02 })).toBe(true);
    expect(isLiquidTerrain({ id: 'mop', name: 'Freshly Mopped Floor', height: 0 })).toBe(true);
    expect(isLiquidTerrain({ id: 'vent-grate', name: 'Vent Grate', height: 0 })).toBe(false);
    expect(isLiquidTerrain({ id: 'water-tank', name: 'Water Tank', height: 1.2 })).toBe(false);
    expect(isLiquidTerrain(undefined)).toBe(false);
  });

  it('fades patch borders but keeps shared edges solid', () => {
    const alone = () => false;
    const all = () => true;
    expect(patchAlpha(0.5, 0.5, alone)).toBe(1);
    expect(patchAlpha(0, 0.5, alone)).toBeLessThan(0.5);
    expect(patchAlpha(0, 0, alone)).toBeLessThan(patchAlpha(0, 0.5, alone));
    expect(patchAlpha(0, 0, all)).toBe(1);
    expect(patchAlpha(1, 0.5, all)).toBe(1);
  });

  it('PatchLayer hides unseen tiles, dims remembered ones and keeps soft borders', () => {
    const tiles = [
      { tile: 0, x: 0, y: 0 },
      { tile: 1, x: 1, y: 0 },
    ];
    const set = new Set([0, 1]);
    const l = new PatchLayer(tiles, (x, y) => y === 0 && set.has(x), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true }), 0.01, 'p');
    const colors = l.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.itemSize).toBe(4);
    expect(colors.getW(4)).toBe(0); // unseen
    l.setSeen(0, 2, new THREE.Color(0.3, 0.3, 0.4));
    expect(colors.getW(4)).toBe(1); // centre of tile 0
    // the shared edge between the two tiles (u = 1) is solid, the outer edge (u = 0) soft
    expect(l.alphaAt(0, 2, 1)).toBe(1);
    expect(l.alphaAt(0, 0, 1)).toBeLessThan(0.5);
    l.setSeen(0, 1, new THREE.Color(0.3, 0.3, 0.4));
    expect(colors.getX(4)).toBeCloseTo(0.3);
    expect(l.seenState(0)).toBe(1);
    l.dispose();
  });
});

describe('backdrop', () => {
  it('resolves every style with two colours and clamps intensity', () => {
    for (const style of BACKDROP_STYLES) {
      const p = backdropParams({ style, color: '#101020', intensity: 2 });
      expect(p.style).toBe(style);
      expect(p.styleIndex).toBe(BACKDROP_STYLES.indexOf(style));
      expect(p.color2).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.color2).not.toBe(p.color);
      expect(p.intensity).toBe(1);
      expect(backdropHorizonColor(p)).toMatch(/^#[0-9a-f]{6}$/);
    }
    // stars/grid lines on a dark base are light
    expect(luminance(backdropParams({ style: 'starfield', color: '#050510', intensity: 0.5 }).color2)).toBeGreaterThan(0.3);
    expect(backdropParams({ style: 'grid', color: '#000000', color2: '#ff00ff', intensity: 0.5 }).color2).toBe('#ff00ff');
  });

  it('shows the dome only when the plan has a backdrop, never fogged or depth-tested', () => {
    const b = new Backdrop();
    expect(b.configure(undefined)).toBeNull();
    expect(b.mesh.visible).toBe(false);
    expect(b.configure({ style: 'aurora', color: '#05101a', color2: '#4dffb0', intensity: 0.7 })).toBe('#05101a');
    expect(b.mesh.visible).toBe(true);
    expect(b.material.fog).toBe(false);
    expect(b.material.depthTest).toBe(false);
    expect(b.material.uniforms.uStyle.value).toBe(BACKDROP_STYLES.indexOf('aurora'));
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(3, 10, 4);
    b.update(0.5, cam);
    expect(b.mesh.position.toArray()).toEqual([3, 10, 4]);
    expect(b.material.uniforms.uTime.value).toBeCloseTo(0.5);
    b.reduceMotion = true;
    b.update(0.5, cam);
    expect(b.material.uniforms.uTime.value).toBeCloseTo(0.5);
    b.dispose();
  });
});

describe('camera framing', () => {
  it('shows about DEFAULT_HALF_WIDTH tiles to each side on landscape screens', () => {
    const d = defaultDistance(1.6);
    const half = d * Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180) * 1.6;
    expect(half).toBeCloseTo(DEFAULT_HALF_WIDTH, 1);
    expect(defaultDistance(0.5)).toBeLessThanOrEqual(MAX_DIST);
    expect(defaultDistance(0.5)).toBeGreaterThanOrEqual(MIN_DIST);
    // portrait is framed by height, not zoomed out to fit the width
    expect(defaultDistance(0.5)).toBeLessThan(DEFAULT_HALF_WIDTH / (Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180) * 0.5));
  });

  it('follows the aspect ratio until the player zooms', () => {
    const rig = new CameraRig(1.6);
    rig.setAspect(2);
    expect(rig.userDist).toBeCloseTo(defaultDistance(2));
    rig.zoom(1);
    const chosen = rig.userDist;
    rig.setAspect(1.2);
    expect(rig.userDist).toBe(chosen);
  });
});

describe('AreaView M2 looks', () => {
  const world = loadWorld('fixture-western');
  const base = world.areas[0];
  const flood = { ...world.terrains[0], id: 'flood', name: 'Flood Water', height: 0, walkable: true, blocksSight: false, model: undefined, color: '#4895ef' };
  const w2: WorldSpec = { ...world, terrains: [...world.terrains, flood] };
  const plan = (p: Partial<AreaPlan>): AreaPlan => ({ ...base, ...p });
  const rows = ['          ', ' ######## ', ' #S.ww..# ', ' #..~~..# ', ' #.....T# ', ' ######## ', '          '];

  it('draws rocky undersides for islands and straight skirts elsewhere', () => {
    const isl = new AreaView(w2, plan({ generator: 'islands' }), area(mapFrom(rows)));
    expect(isl.stats().underside).toBeGreaterThan(20);
    const town = new AreaView(w2, plan({ generator: 'town' }), area(mapFrom(rows)));
    expect(town.stats().underside).toBeGreaterThan(10);
    const inner = mapFrom(rows.map((r) => r.replace(/ /g, '#')));
    const closed = new AreaView(w2, plan({ generator: 'town' }), area(inner));
    expect(closed.stats().underside ?? 0).toBe(0);
    isl.dispose();
    town.dispose();
    closed.dispose();
  });

  it('organic walls are blobs, geometric walls get glowing edges, box walls a lighter outline', () => {
    const org = new AreaView(w2, plan({ generator: 'organic' }), area(mapFrom(rows)));
    expect(org.wallStyle).toBe('blob');
    expect(Object.keys(org.stats()).some((k) => k.startsWith('wall-edges'))).toBe(false);
    const geo = new AreaView(w2, plan({ generator: 'geometric' }), area(mapFrom(rows)));
    const edge = geo.group.children.find((c) => c.name.startsWith('wall-edges')) as THREE.Mesh;
    expect(edge).toBeTruthy();
    expect((edge.material as THREE.Material).type).toBe('MeshBasicMaterial');
    const box = new AreaView(w2, plan({ generator: 'rooms' }), area(mapFrom(rows)));
    expect(box.group.children.some((c) => c.name.startsWith('wall-edges'))).toBe(true);
    // the wall cap is lighter than the wall itself
    const walls = box.group.getObjectByName('walls') as THREE.Mesh;
    const mats = walls.material as THREE.MeshStandardMaterial[];
    expect(luminance('#' + mats[2].color.getHexString())).toBeGreaterThan(luminance(base.wall.color));
    for (const v of [org, geo, box]) v.dispose();
  });

  it('water tiles and liquid terrain are soft translucent patches with a sunken bed', () => {
    const v = new AreaView(w2, plan({ generator: 'rooms' }), area(mapFrom(rows)));
    const s = v.stats();
    expect(s.water).toBe(2);
    expect(s['water-bed']).toBe(2);
    expect(s['terrain:flood']).toBe(2);
    const water = v.group.getObjectByName('water') as THREE.Mesh;
    const m = water.material as THREE.MeshStandardMaterial;
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBeLessThan(0.9);
    expect(m.roughness).toBeLessThan(0.3);
    expect(water.position.y + (water.geometry.getAttribute('position') as THREE.BufferAttribute).getY(0)).toBeLessThan(0);
    v.update(1, 0.016);
    v.dispose();
  });

  it('eases walls far in front of / behind the player down to 70 % and keeps nearby walls full height', () => {
    const big = ['############', '#S.........#', '#..........#', '#..........#', '#..........#', '#.........T#', '############'];
    const v = new AreaView(w2, plan({ generator: 'rooms' }), area(mapFrom(big)));
    const W = 12;
    v.setFocus({ x: 5, y: 3 }, 0, true);
    // camera south (step 0): row 6 is 3 rows towards the camera, row 0 is 3 rows behind
    expect(v.wallProfileAt(6 * W + 5)).toBeCloseTo(PROFILE_FAR);
    expect(v.wallProfileAt(0 * W + 5)).toBeCloseTo(PROFILE_FAR);
    expect(v.wallProfileAt(3 * W + 0)).toBe(1);
    // animated when the player moves
    v.setFocus({ x: 5, y: 5 }, 0);
    for (let k = 0; k < 120; k++) v.update(k * 0.016, 0.016);
    expect(v.wallProfileAt(6 * W + 5)).toBe(1);
    // the cut-away stub height wins over the profile
    v.setCutaway(new Set([6 * W + 5]));
    expect(v.inspect(6 * W + 5).wallScale * v.wallHeight).toBeCloseTo(STUB_HEIGHT);
    v.dispose();
  });
});

describe('actor readability', () => {
  it('scales small creatures up to a minimum height and everyone a little', () => {
    expect(actorScaleFor(1)).toBe(ACTOR_SCALE);
    expect(0.2 * actorScaleFor(0.2)).toBeCloseTo(MIN_ACTOR_HEIGHT);
  });

  it('flags models that melt into the floor', () => {
    expect(lowContrast('#8a6a4a', '#8c6c4a')).toBe(true);
    expect(lowContrast('#202020', '#e0e0e0')).toBe(false);
    expect(lowContrast(undefined, '#ffffff')).toBe(false);
  });

  it('outlines every actor in its faction colour and gives the player a pulse ring', () => {
    const world = loadWorld('fixture-western');
    const layer = new ActorLayer(world);
    const baseA = { mp: 0, maxMp: 0, base: { str: 1, dex: 1, int: 1, ac: 1, speed: 100, sight: 5 }, statuses: [], energy: 0, cooldowns: {}, ai: { alerted: false }, tempMods: [] };
    const p = layer.ensure({ ...baseA, id: 'p', defId: 'player', pos: { x: 0, y: 0 }, hp: 5, maxHp: 5, faction: 'player' }, true);
    const e = layer.ensure({ ...baseA, id: 'e', defId: world.actors[0].id, pos: { x: 1, y: 0 }, hp: 5, maxHp: 5, faction: 'hostile' }, false);
    expect(p.outlines.length).toBeGreaterThan(0);
    expect(p.pulse).toBeTruthy();
    expect(e.pulse).toBeUndefined();
    expect(e.height).toBeGreaterThanOrEqual(MIN_ACTOR_HEIGHT - 1e-6);
    const before = (e.outlines[0].material as THREE.MeshBasicMaterial).color.getHex();
    layer.setFaction(e, 'friendly');
    expect((e.outlines[0].material as THREE.MeshBasicMaterial).color.getHex()).not.toBe(before);
    expect((p.ring.material as THREE.MeshBasicMaterial).opacity).toBe(1);
    layer.update(1.2, new THREE.PerspectiveCamera());
    layer.dispose();
  });
});
