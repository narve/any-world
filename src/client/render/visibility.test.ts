/**
 * M1 issue: in dark areas, actors the engine counts as visible were not drawn (an "invisible
 * shooter"). The engine's sight is top-down; the camera's is a tilted perspective, so a visible actor
 * could be hidden behind a wall (perspective slants the sight line sideways), off the bottom of the
 * screen, lost in fog or simply too dark. These tests pin each part of the fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { cutawayTiles, occluderTiles } from './cutaway';
import { CameraRig, MAX_DIST } from './camera';
import { LightRig } from './lighting';
import { ActorLayer } from './actors';
import { visibleRadius } from './index';
import { parseWorld } from '../../schema/refs';
import type { WorldSpec } from '../../schema/world';
import type { ActorInstance } from '../../engine/types';

function shipWorld(): WorldSpec {
  const res = parseWorld(JSON.parse(readFileSync('content/worlds/fixture-ship.json', 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.world;
}

/** ASCII map: '#' tall, anything else open. */
function grid(rows: string[]) {
  const width = rows[0].length;
  const height = rows.length;
  return { width, height, isTall: (i: number) => rows[Math.floor(i / width)][i % width] === '#' };
}

describe('occluderTiles (walls between a visible actor and the camera)', () => {
  // The playtest geometry: an east-west duct, the player at (3,1), the warden at (8,1). The camera
  // sits south of the player, so the line from the warden to the camera slants south-west and
  // crosses the wall at (7,2), which the old straight wedge never lowered.
  const map = grid([
    '##############',
    '#............#',
    '#.....###.#..#',
    '#............#',
  ]);
  const rig = new CameraRig(1280 / 800);
  rig.follow(new THREE.Vector3(3, 0, 1), true);
  rig.settle();
  const eye = rig.restingPosition();

  it('lowers the wall the perspective sight line crosses, not only the one straight in front', () => {
    const set = occluderTiles(map, { x: 8, y: 1 }, eye, { height: 1.7, tallHeight: 1.6 });
    expect(set.has(2 * 14 + 7)).toBe(true);
    // the old cut-away (player wedge + adjacent actors only) left it standing
    const old = cutawayTiles(map, { x: 3, y: 1 }, 0, { depth: 3, halfWidth: 2, spread: 0.6, around: 0.5 });
    expect(old.has(2 * 14 + 7)).toBe(false);
  });

  it('never lowers tiles behind the actor or the actor tile itself, and stops once the line clears the walls', () => {
    const set = occluderTiles(map, { x: 8, y: 1 }, eye, { height: 1.7, tallHeight: 1.6 });
    for (const i of set) {
      const y = Math.floor(i / 14);
      expect(y).toBeGreaterThanOrEqual(2); // only rows between the actor and the camera (south)
      expect(y).toBeLessThanOrEqual(3);
    }
    expect(set.has(0 * 14 + 8)).toBe(false);
    // an actor taller than every wall still needs its feet cleared, but a line starting above them is skipped
    expect(occluderTiles(map, { x: 8, y: 1 }, eye, { height: 1.7, tallHeight: 0.01 }).size).toBe(0);
  });

  it('follows the camera when it is rotated', () => {
    const r = new CameraRig(1.6);
    r.follow(new THREE.Vector3(3, 0, 1), true);
    r.rotate(1);
    r.settle();
    const e = r.restingPosition();
    const set = occluderTiles(map, { x: 8, y: 1 }, e, { height: 1.7, tallHeight: 1.6 });
    for (const i of set) expect([1, 2, 3].includes(Math.floor(i / 14))).toBe(true);
  });
});

describe('CameraRig framing (visible actors must be on screen)', () => {
  const at = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, y);

  it('needs to zoom out for an actor 5 tiles towards the camera at the default zoom', () => {
    const rig = new CameraRig(1280 / 800);
    rig.follow(at(10, 10), true);
    rig.settle();
    const near = rig.distanceToFrame([at(12, 10), at(12, 10, 1.7)], rig.userDist);
    expect(near).toBe(rig.userDist); // already framed
    const south = rig.distanceToFrame([at(10, 15), at(10, 15, 1.7)], rig.userDist);
    expect(south).toBeGreaterThan(rig.userDist);
    expect(south).toBeLessThanOrEqual(MAX_DIST);
    // at that distance the point projects inside the viewport
    rig.setFrameDist(south);
    rig.settle();
    const p = at(10, 15).project(rig.camera);
    expect(p.y).toBeGreaterThan(-1);
    expect(p.y).toBeLessThan(1);
  });

  it('keeps the larger of the user zoom and the framing distance; zooming in drops the framing until reframed', () => {
    const rig = new CameraRig(1.6);
    rig.setZoom(10, true);
    rig.setFrameDist(18);
    expect(rig.distTarget).toBe(18);
    rig.setFrameDist(0);
    expect(rig.distTarget).toBe(10);
    rig.setFrameDist(18);
    rig.zoom(-1);
    expect(rig.frameDist).toBe(0);
    expect(rig.distTarget).toBeLessThan(18);
    expect(rig.distTarget).toBeGreaterThan(10); // zoomed in from what was on screen
    rig.zoom(1);
    expect(rig.userDist).toBe(rig.distTarget);
  });
});

describe('LightRig follows the engine sight', () => {
  const world = shipWorld();
  const ducts = world.areas.find((a) => a.name === 'The Ductworks')!;

  it('starts fog beyond the sight radius and reaches it with the player light', () => {
    const rig = new LightRig();
    rig.configure(ducts.lighting, new THREE.Scene());
    const before = rig.fogRange(11.5);
    rig.setSightRadius(9);
    const after = rig.fogRange(11.5);
    expect(after.near).toBeGreaterThan(before.near + 5);
    expect(after.far).toBeGreaterThan(after.near);
    expect(rig.player.distance).toBeGreaterThanOrEqual(9);
  });

  it('gives actors an emissive floor that grows with darkness', () => {
    const rig = new LightRig();
    rig.configure(ducts.lighting, new THREE.Scene());
    const dark = rig.actorLightFloor;
    rig.configure({ ...ducts.lighting, ambientIntensity: 0.9 }, new THREE.Scene());
    const bright = rig.actorLightFloor;
    expect(dark).toBeGreaterThanOrEqual(0.15);
    expect(bright).toBeLessThan(dark);
  });
});

describe('ActorLayer light floor and markers', () => {
  const world = shipWorld();
  const warden = world.actors.find((a) => /Ostrova/.test(a.name))!;
  const inst = { id: 'w1', defId: warden.id, pos: { x: 1, y: 1 }, faction: 'hostile', hp: 10, maxHp: 10, statuses: [] } as unknown as ActorInstance;

  it('lifts actor materials without touching shared (cached) materials, including faded copies', () => {
    const layer = new ActorLayer(world);
    const v = layer.ensure(inst, false);
    const mats = () => {
      const out: THREE.MeshStandardMaterial[] = [];
      v.model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) for (const x of [m.material].flat()) out.push(x as THREE.MeshStandardMaterial);
      });
      return out;
    };
    expect(mats().every((m) => !m.userData.cached)).toBe(true);
    layer.setLightFloor(0.25);
    const lit = mats().filter((m) => m.userData.floorBase);
    expect(lit.length).toBeGreaterThan(0);
    for (const m of lit) expect(m.emissive.r + m.emissive.g + m.emissive.b).toBeGreaterThan(0.05);
    layer.setOpacity(v, 0.5); // fade copies keep the floor and follow later changes
    layer.setLightFloor(0);
    for (const m of mats()) if (m.userData.floorBase) expect(m.emissive.getHex()).toBe(0);
    layer.setLightFloor(0.25);
    expect(mats().some((m) => m.emissive.getHex() !== 0)).toBe(true);
    layer.dispose();
  });

  it('draws the faction ring without fog or tone mapping', () => {
    const layer = new ActorLayer(world);
    const v = layer.ensure(inst, false);
    expect(v.ringMat.fog).toBe(false);
    expect(v.ringMat.toneMapped).toBe(false);
    layer.dispose();
  });
});

describe('visibleRadius', () => {
  it('is the distance to the farthest tile the engine marks visible', () => {
    const W = 10;
    const seen = new Uint8Array(W * 10);
    seen[5 * W + 5] = 2;
    seen[5 * W + 9] = 2;
    seen[0] = 1; // remembered, not visible
    expect(visibleRadius({ seen, map: { width: W } as never }, { x: 5, y: 5 })).toBeCloseTo(4);
    expect(visibleRadius({ seen: new Uint8Array(W * 10), map: { width: W } as never }, { x: 5, y: 5 })).toBe(0);
  });
});
