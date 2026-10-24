/**
 * Regression tests for the M2 playtest round-1 renderer issues (issues/M2-*.md):
 *  - floating status labels stay over their actor (M2-status-label-left-behind)
 *  - liquid terrain is a flat water surface, never spiky stars (M2-liquid-terrain-stars)
 *  - remembered walls keep a dark body and a clear outline (M2-remembered-walls-low-contrast)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../schema/refs';
import type { WorldSpec, AreaPlan } from '../../schema/world';
import type { AreaMap, AreaState, Tile } from '../../engine/types';
import { AreaView, REMEMBER_WALL, REMEMBER_EDGE, LIQUID_TERRAIN_ROUGHNESS } from './tiles';
import { PatchLayer, patchGrow } from './surfaces';
import { VfxLayer } from './vfx';
import { Animator } from './tween';

function loadWorld(name: string): WorldSpec {
  const res = parseWorld(JSON.parse(readFileSync(join(__dirname, `../../../content/worlds/${name}.json`), 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.world;
}

/** '#' wall, ' ' void, 'S' start, 'T' exit, 'w' seep-water terrain, anything else floor */
function mapFrom(rows: string[], terrain = 'seep-water'): AreaMap {
  const tiles: Tile[] = [];
  for (const r of rows)
    for (const ch of r)
      tiles.push(ch === '#' ? { kind: 'wall' } : ch === ' ' ? { kind: 'void' } : ch === 'S' ? { kind: 'start' } : ch === 'T' ? { kind: 'transition' } : { kind: 'floor', terrain: ch === 'w' ? terrain : undefined });
  const W = rows[0].length;
  const s = tiles.findIndex((t) => t.kind === 'start');
  const e = tiles.findIndex((t) => t.kind === 'transition');
  return { width: W, height: rows.length, tiles, start: { x: s % W, y: Math.floor(s / W) }, exit: { x: e % W, y: Math.floor(e / W) }, regions: [] };
}

const area = (map: AreaMap, seen = 2): AreaState => ({ index: 0, map, actors: [], items: [], seen: new Array(map.tiles.length).fill(seen), discoveredRegions: [], gmBudget: 0 });

// ---------------------------------------------------------------------------
// Floating text follows its actor
// ---------------------------------------------------------------------------

describe('floating text (M2-status-label-left-behind)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** a canvas good enough for textTexture() under node */
  function stubCanvas() {
    const ctx = new Proxy({ measureText: () => ({ width: 80 }) } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : () => undefined),
      set: () => true,
    });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  }

  it('stays over the actor it labels while the actor walks away, and hides with it', () => {
    stubCanvas();
    const anim = new Animator();
    anim.tick(0);
    const vfx = new VfxLayer(anim);
    const actor = new THREE.Object3D();
    actor.position.set(3, 0, 4);
    const s = vfx.text(new THREE.Vector3(3, 1.5, 4), 'Muffled', '#6c757d', 0, { duration: 1200, follow: actor });
    expect(s).not.toBeNull();
    anim.tick(100);
    const jitter = s!.position.x - 3;
    expect(Math.abs(jitter)).toBeLessThan(0.2);
    expect(s!.position.z).toBeCloseTo(4);
    // the actor moves six tiles before the label has finished
    actor.position.set(9, 0, 1);
    anim.tick(600);
    expect(s!.position.x).toBeCloseTo(9 + jitter);
    expect(s!.position.z).toBeCloseTo(1);
    expect(s!.position.y).toBeGreaterThan(1.5);
    expect(s!.visible).toBe(true);
    actor.visible = false;
    anim.tick(700);
    expect(s!.visible).toBe(false);
    anim.tick(5000);
    expect(vfx.group.children).not.toContain(s);
  });

  it('without follow, text stays where it was spawned', () => {
    stubCanvas();
    const anim = new Animator();
    anim.tick(0);
    const vfx = new VfxLayer(anim);
    const s = vfx.text(new THREE.Vector3(2, 1, 2), '5', '#ff0000');
    anim.tick(300);
    expect(s!.position.z).toBeCloseTo(2);
  });
});

// ---------------------------------------------------------------------------
// Liquid terrain
// ---------------------------------------------------------------------------

describe('liquid terrain patches (M2-liquid-terrain-stars)', () => {
  /** patch tiles from rows of '#'(in) / '.'(out) */
  function patch(rows: string[]) {
    const W = rows[0].length;
    const set = new Set<number>();
    rows.forEach((r, y) => [...r].forEach((c, x) => c === '#' && set.add(y * W + x)));
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < rows.length && set.has(y * W + x);
    const tiles = [...set].map((i) => ({ tile: i, x: i % W, y: Math.floor(i / W) }));
    return { tiles, inside };
  }

  const shapes: Record<string, string[]> = {
    single: ['#'],
    disc: ['..#..', '.###.', '#####', '.###.', '..#..'],
    ell: ['#..', '#..', '###'],
    diagonal: ['#..', '.#.', '..#'],
    ring: ['###', '#.#', '###'],
  };

  for (const [name, rows] of Object.entries(shapes)) {
    it(`no triangle folds over its neighbour (${name})`, () => {
      const { tiles, inside } = patch(rows);
      const l = new PatchLayer(tiles, inside, new THREE.MeshBasicMaterial(), 0.01, 'p', 0.5, 0.12);
      expect(l.foldedTriangles()).toBe(0);
      l.dispose();
    });

    it(`tiles sharing a vertex place it at the same spot (${name})`, () => {
      const { tiles, inside } = patch(rows);
      const pad = 0.12;
      const at = new Map<string, string>();
      for (const t of tiles)
        for (let vy = 0; vy < 3; vy++)
          for (let vx = 0; vx < 3; vx++) {
            const u = vx / 2;
            const v = vy / 2;
            const [gx, gz] = patchGrow(u, v, (dx, dy) => inside(t.x + dx, t.y + dy));
            const key = `${t.x * 2 + vx},${t.y * 2 + vy}`;
            const where = `${(t.x - 0.5 + u + gx * pad).toFixed(3)},${(t.y - 0.5 + v + gz * pad).toFixed(3)}`;
            const prev = at.get(key);
            if (prev !== undefined) expect(where, `vertex ${key}`).toBe(prev);
            at.set(key, where);
          }
    });
  }

  it('interior vertices never move, border vertices move outward only', () => {
    const all = () => true;
    const none = () => false;
    expect(patchGrow(0, 0, all)).toEqual([0, 0]);
    expect(patchGrow(0.5, 0.5, none)).toEqual([0, 0]);
    expect(patchGrow(0, 0.5, none)).toEqual([-1, 0]);
    expect(patchGrow(1, 1, none)).toEqual([1, 1]);
  });

  it('teen seep water is a matte, flat water surface (no glinting normal map)', () => {
    const world = loadWorld('fixture-teen');
    const plan: AreaPlan = world.areas[0];
    const v = new AreaView(world, plan, area(mapFrom(['########', '#S.ww..#', '#.www..#', '#..w..T#', '########'])));
    const info = v.liquidTerrainInfo();
    expect(info.map((i) => i.name)).toEqual(['terrain:seep-water']);
    expect(info[0].roughness).toBe(LIQUID_TERRAIN_ROUGHNESS);
    expect(info[0].roughness).toBeGreaterThanOrEqual(0.4);
    expect(info[0].normalMap).toBe(false);
    expect(info[0].opacity).toBeLessThan(0.8);
    expect(info[0].folded).toBe(0);
    v.dispose();
  });
});

// ---------------------------------------------------------------------------
// Remembered walls
// ---------------------------------------------------------------------------

describe('remembered walls (M2-remembered-walls-low-contrast)', () => {
  const rows = ['#########', '#S..#...#', '#.#.#.#.#', '#.#...#T#', '#########'];

  it('ship Ductworks: outline brighter than the cap, cap brighter than the remembered floor', () => {
    const world = loadWorld('fixture-ship');
    const v = new AreaView(world, world.areas[1], area(mapFrom(rows), 1));
    const c = v.rememberedContrast()!;
    expect(c).not.toBeNull();
    expect(c.edgeVsCap).toBeGreaterThan(0.08);
    expect(c.capVsFloor).toBeGreaterThan(0.05);
    v.dispose();
  });

  it('every fixture area with outlined walls keeps the outline above its remembered cap', () => {
    for (const name of ['fixture-ship', 'fixture-teen', 'fixture-western']) {
      const world = loadWorld(name);
      world.areas.forEach((plan, i) => {
        const v = new AreaView(world, plan, area(mapFrom(rows), 1));
        const c = v.rememberedContrast();
        if (c) expect(c.edgeVsCap, `${name} area ${i}`).toBeGreaterThan(0.05);
        v.dispose();
      });
    }
  });

  it('remembered walls take the dark neutral tint, their outline a light one', () => {
    const world = loadWorld('fixture-ship');
    const map = mapFrom(rows);
    const v = new AreaView(world, world.areas[1], area(map, 2));
    const walls = v.group.getObjectByName('walls') as THREE.InstancedMesh;
    const edges = v.group.children.find((o) => o.name.startsWith('wall-edges')) as THREE.InstancedMesh;
    const lit = new THREE.Color();
    const litEdge = new THREE.Color();
    walls.getColorAt(0, lit);
    edges.getColorAt(0, litEdge);
    v.applySeen(new Array(map.tiles.length).fill(1));
    const dim = new THREE.Color();
    const dimEdge = new THREE.Color();
    walls.getColorAt(0, dim);
    edges.getColorAt(0, dimEdge);
    expect(dim.r / lit.r).toBeCloseTo(REMEMBER_WALL.r);
    expect(dim.b / lit.b).toBeCloseTo(REMEMBER_WALL.b);
    expect(dimEdge.g / litEdge.g).toBeCloseTo(REMEMBER_EDGE.g);
    // neutral, not the blue fog-of-war tint
    expect(REMEMBER_WALL.b - REMEMBER_WALL.r).toBeLessThan(0.08);
    // the outline glows a little so it survives a dark backdrop
    const em = edges.material as THREE.MeshStandardMaterial;
    expect(em.emissiveIntensity).toBeGreaterThan(0);
    v.dispose();
  });
});
