/**
 * AreaView: the static-ish geometry of one area — floors, walls, water, doors, terrain, the
 * transition marker and lamp fixtures — plus fog of war and wall cut-away applied to them.
 * Pure three.js (no WebGLRenderer needed), so it can be unit tested in node.
 */
import * as THREE from 'three';
import type { WorldSpec, AreaPlan, TerrainDef } from '../../schema/world';
import type { AreaMap, AreaState, TileKind } from '../../engine/types';
import { getMaterial, setDimmed } from './materials';
import { patternTexture, glowTexture } from './textures';
import { col, shade, mixHex, hash2 } from './color';
import { buildModel, animateModel } from './models';
import { prim } from './models/geom';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeModel } from './models/merge';

const ORGANIC_GENERATORS = new Set(['caves', 'open']);
export const FLOOR_KINDS: ReadonlySet<TileKind> = new Set(['floor', 'start', 'door', 'door_open', 'transition']);
const LOWERED_HEIGHT = 0.14;

/** visibility per tile: 0 unseen, 1 remembered, 2 visible */
export type SeenArray = ArrayLike<number>;

const REMEMBER = new THREE.Color(0.36, 0.38, 0.48);
const UP = new THREE.Vector3(0, 1, 0);

interface InstEntry {
  tile: number;
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  /** base y scale (height jitter) */
  sy?: number;
  rotY?: number;
  sxz?: number;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

class InstLayer {
  readonly mesh: THREE.InstancedMesh;
  /** instance → tile index */
  readonly tiles: number[];
  /** tile index → instance */
  readonly of = new Map<number, number>();
  private readonly base: Float32Array;
  private readonly pos: Float32Array;
  private readonly sy: Float32Array;
  private readonly state: Uint8Array;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  private readonly baseSy: Float32Array;
  private readonly rotY: Float32Array;
  private readonly sxz: Float32Array;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], entries: InstEntry[], name: string) {
    const n = Math.max(1, entries.length);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.name = name;
    this.mesh.count = entries.length;
    this.mesh.frustumCulled = false;
    this.tiles = entries.map((e) => e.tile);
    this.base = new Float32Array(n * 3);
    this.pos = new Float32Array(n * 3);
    this.sy = new Float32Array(n).fill(-1);
    this.baseSy = new Float32Array(n).fill(1);
    this.rotY = new Float32Array(n);
    this.sxz = new Float32Array(n).fill(1);
    this.state = new Uint8Array(n).fill(255);
    entries.forEach((e, i) => {
      this.of.set(e.tile, i);
      this.baseSy[i] = e.sy ?? 1;
      this.rotY[i] = e.rotY ?? 0;
      this.sxz[i] = e.sxz ?? 1;
      this.pos.set([e.x, e.y, e.z], i * 3);
      this.base.set([e.color.r, e.color.g, e.color.b], i * 3);
      this.mesh.setMatrixAt(i, ZERO);
      this.mesh.setColorAt(i, e.color);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private write(i: number): void {
    const st = this.state[i];
    if (st === 0 || st === 255) {
      this.mesh.setMatrixAt(i, ZERO);
    } else {
      this.v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.s.set(this.sxz[i], this.sy[i] >= 0 ? this.sy[i] : this.baseSy[i], this.sxz[i]);
      this.q.setFromAxisAngle(UP, this.rotY[i]);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setSeen(tile: number, st: number): void {
    const i = this.of.get(tile);
    if (i === undefined || this.state[i] === st) return;
    const wasHidden = this.state[i] === 0 || this.state[i] === 255;
    this.state[i] = st;
    this.writeColor(i);
    if (wasHidden || st === 0) this.write(i);
  }

  private writeColor(i: number): void {
    this.c.setRGB(this.base[i * 3], this.base[i * 3 + 1], this.base[i * 3 + 2]);
    if (this.state[i] === 1) this.c.multiply(REMEMBER);
    if (this.sy[i] >= 0) this.c.multiplyScalar(0.55); // lowered (cut-away) stubs read as cut, not as floor
    this.mesh.setColorAt(i, this.c);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** absolute y scale override; pass -1 to restore the instance's own height */
  setScaleY(tile: number, sy: number): void {
    const i = this.of.get(tile);
    if (i === undefined || this.sy[i] === sy) return;
    this.sy[i] = sy;
    this.write(i);
    if (this.state[i] !== 255) this.writeColor(i);
  }

  seenState(tile: number): number {
    const i = this.of.get(tile);
    return i === undefined ? -1 : this.state[i];
  }

  scaleY(tile: number): number {
    const i = this.of.get(tile);
    return i === undefined ? 1 : this.sy[i] >= 0 ? this.sy[i] : this.baseSy[i];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

interface DoorView {
  obj: THREE.Group;
  panel: THREE.Object3D;
  open: boolean;
  sliding: boolean;
  /** 0 closed .. 1 open (animated) */
  k: number;
}

export interface LampView {
  tile: number;
  /** world position of the bulb */
  pos: THREE.Vector3;
  obj: THREE.Object3D;
  glow: THREE.Sprite;
  phase: number;
  /** current flicker multiplier (0..1.2) — read by the lighting rig */
  flicker: number;
  visible: boolean;
}

/**
 * Generic terrain shape when a TerrainDef has no model: flat patch (h < 0.06), a clump of rounded
 * lumps for low walkable terrain, or a chamfered block for tall / blocking terrain.
 */
function genericTerrainGeometry(h: number, walkable: boolean): THREE.BufferGeometry {
  if (h < 0.06) {
    const g = new THREE.BoxGeometry(0.9, Math.max(0.02, h), 0.9);
    g.translate(0, Math.max(0.02, h) / 2 + 0.004, 0);
    return g;
  }
  if (walkable && h < 0.8) {
    const lumps: [number, number, number, number][] = [
      [0, 0, 0, 0.42],
      [-0.22, 0, 0.16, 0.3],
      [0.2, 0, -0.18, 0.32],
      [0.18, 0, 0.22, 0.24],
      [-0.2, 0, -0.2, 0.22],
    ];
    const parts = lumps.map(([x, , z, r], k) => {
      const g = new THREE.IcosahedronGeometry(r, 0);
      g.scale(1, (h / r) * (k === 0 ? 1 : 0.7), 1);
      g.translate(x, (h * (k === 0 ? 1 : 0.7)) / 2, z);
      return g.index ? g.toNonIndexed() : g;
    });
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    merged.computeVertexNormals();
    return merged;
  }
  const g = new THREE.BoxGeometry(0.82, h, 0.82, 1, 1, 1);
  // chamfer the top by pulling the top vertices in a little
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setXYZ(i, pos.getX(i) * 0.86, pos.getY(i), pos.getZ(i) * 0.86);
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  return g;
}

function tileKey(t: { kind: string; terrain?: string }): string {
  return `${t.kind}:${t.terrain ?? ''}`;
}

export class AreaView {
  readonly group = new THREE.Group();
  readonly width: number;
  readonly height: number;
  readonly wallHeight: number;
  readonly plan: AreaPlan;
  readonly world: WorldSpec;
  lamps: LampView[] = [];
  /** light-emitting terrain/transition models (position + light spec) for the light pool */
  lightSources: { pos: THREE.Vector3; tile: number; color: string; intensity: number; radius: number }[] = [];
  /** world position of the transition marker (if any) */
  exitPos: THREE.Vector3 | null = null;

  private floor: InstLayer | null = null;
  private water: InstLayer | null = null;
  private walls: InstLayer | null = null;
  private ghost: InstLayer | null = null;
  private terrainLayers: InstLayer[] = [];
  private terrainGroup = new THREE.Group();
  private terrainModels = new Map<number, THREE.Object3D>();
  private tallTerrain = new Set<number>();
  private doors = new Map<number, DoorView>();
  private transition: THREE.Object3D | null = null;
  private exitModel: THREE.Object3D | null = null;
  private seen: Uint8Array;
  private lowered = new Set<number>();
  private keys: string[];
  private terrainDefs = new Map<string, TerrainDef>();
  private exitIdx = -1;
  private waterTex: THREE.Texture | null = null;

  constructor(world: WorldSpec, plan: AreaPlan, area: AreaState) {
    this.world = world;
    this.plan = plan;
    const map = area.map;
    this.width = map.width;
    this.height = map.height;
    this.wallHeight = plan.wall?.height ?? 1.4;
    this.group.name = 'area';
    this.seen = new Uint8Array(map.width * map.height).fill(255);
    this.keys = map.tiles.map(tileKey);
    for (const t of world.terrains ?? []) this.terrainDefs.set(t.id, t);
    this.buildFloorsAndWalls(map);
    this.group.add(this.terrainGroup);
    this.buildTerrain(map);
    this.buildDoors(map);
    this.buildTransition(map);
    this.buildLamps(map);
    this.applySeen(area.seen);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  private kindAt(map: AreaMap, x: number, y: number): TileKind | null {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
    return map.tiles[this.idx(x, y)].kind;
  }

  private buildFloorsAndWalls(map: AreaMap): void {
    const plan = this.plan;
    const fl = plan.floor;
    const wl = plan.wall;
    const H = this.wallHeight;

    // --- floors ---
    const floorTex = patternTexture(fl.pattern ?? 'plain', fl.color, fl.color2, 11);
    const floorTop = getMaterial(fl.material === 'glow' ? 'matte' : fl.material, floorTex ? '#ffffff' : fl.color, { map: floorTex });
    const floorSide = getMaterial('stone', shade(fl.color, 0.55));
    const floorGeo = new THREE.BoxGeometry(1, 0.2, 1);
    floorGeo.translate(0, -0.1, 0);
    const floorEntries: InstEntry[] = [];
    const waterEntries: InstEntry[] = [];
    const wallEntries: InstEntry[] = [];
    const organic = ORGANIC_GENERATORS.has(plan.generator);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = this.idx(x, y);
        const t = map.tiles[i];
        if (FLOOR_KINDS.has(t.kind)) {
          let j = 0.93 + hash2(x, y) * 0.12;
          // soft contact shadow next to walls
          let nearWall = 0;
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.kindAt(map, x + ox, y + oy) === 'wall') nearWall++;
          j *= 1 - Math.min(2, nearWall) * 0.07;
          floorEntries.push({ tile: i, x, y: 0, z: y, color: new THREE.Color(j, j, j) });
        } else if (t.kind === 'water') {
          const j = 0.95 + hash2(x, y, 3) * 0.1;
          waterEntries.push({ tile: i, x, y: -0.07, z: y, color: new THREE.Color(j, j, j) });
        } else if (t.kind === 'wall') {
          let exposed = false;
          for (let oy = -1; oy <= 1 && !exposed; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const k = this.kindAt(map, x + ox, y + oy);
              if (k !== null && k !== 'wall') {
                exposed = true;
                break;
              }
            }
          if (exposed) {
            const j = 0.9 + hash2(x, y, 7) * 0.14;
            const sy = organic ? 0.78 + hash2(x, y, 17) * 0.4 : 1;
            wallEntries.push({ tile: i, x, y: 0, z: y, color: new THREE.Color(j, j, j), sy });
          }
        }
      }
    }
    this.floor = new InstLayer(floorGeo, [floorSide, floorSide, floorTop, floorSide, floorSide, floorSide], floorEntries, 'floor');
    this.floor.mesh.receiveShadow = true;
    this.group.add(this.floor.mesh);

    if (waterEntries.length) {
      const wcol = fl.pattern === 'water' ? fl.color : mixHex('#2d6f93', fl.color, 0.2);
      const wcol2 = fl.pattern === 'water' ? fl.color2 ?? shade(fl.color, 1.2) : '#4fa3c7';
      this.waterTex = patternTexture('water', wcol, wcol2, 5);
      const wmat = getMaterial('glass', this.waterTex ? '#ffffff' : wcol, { map: this.waterTex, opacity: 0.88 });
      wmat.roughness = 0.15;
      wmat.metalness = 0.1;
      wmat.depthWrite = true;
      const wgeo = new THREE.BoxGeometry(1, 0.14, 1);
      wgeo.translate(0, -0.07, 0);
      this.water = new InstLayer(wgeo, wmat, waterEntries, 'water');
      this.water.mesh.receiveShadow = true;
      this.group.add(this.water.mesh);
    }

    // --- walls ---
    const wallTex = patternTexture(wl.pattern ?? 'plain', wl.color, wl.color2, 23);
    const wallSide = getMaterial(wl.material === 'glow' ? 'matte' : wl.material, wallTex ? '#ffffff' : wl.color, { map: wallTex });
    const wallTop = getMaterial('matte', shade(mixHex(wl.color, wl.color2 ?? wl.color, 0.25), 0.62));
    const wallGeo = new THREE.BoxGeometry(1, H, 1);
    wallGeo.translate(0, H / 2, 0);
    // tile the side texture vertically so tall walls are not stretched
    const uv = wallGeo.getAttribute('uv') as THREE.BufferAttribute;
    const sideVerts = new Set<number>();
    const index = wallGeo.index!.array as ArrayLike<number>;
    for (const g of wallGeo.groups) {
      if (g.materialIndex === 2 || g.materialIndex === 3) continue;
      for (let k = g.start; k < g.start + g.count; k++) sideVerts.add(index[k]);
    }
    for (const vi of sideVerts) uv.setY(vi, uv.getY(vi) * H);
    uv.needsUpdate = true;
    this.walls = new InstLayer(wallGeo, [wallSide, wallSide, wallTop, wallTop, wallSide, wallSide], wallEntries, 'walls');
    this.walls.mesh.castShadow = true;
    this.walls.mesh.receiveShadow = true;
    this.group.add(this.walls.mesh);
    // translucent full-height copies shown over lowered (cut-away) walls so rooms keep their shape
    const ghostMat = new THREE.MeshStandardMaterial({ color: col(wl.color), transparent: true, opacity: 0.09, depthWrite: false, roughness: 1 });
    ghostMat.userData.owned = true;
    this.ghost = new InstLayer(wallGeo.clone(), ghostMat, wallEntries, 'wall-ghosts');
    this.ghost.mesh.renderOrder = 5;
    this.group.add(this.ghost.mesh);
  }

  private buildTerrain(map: AreaMap): void {
    for (const l of this.terrainLayers) {
      this.terrainGroup.remove(l.mesh);
      l.dispose();
    }
    this.terrainLayers = [];
    for (const m of this.terrainModels.values()) this.terrainGroup.remove(m);
    this.terrainModels.clear();
    this.tallTerrain.clear();
    this.lightSources = this.lightSources.filter((l) => l.tile === this.exitIdx);

    const byDef = new Map<string, number[]>();
    map.tiles.forEach((t, i) => {
      if (!t.terrain) return;
      const arr = byDef.get(t.terrain) ?? [];
      arr.push(i);
      byDef.set(t.terrain, arr);
    });
    for (const [id, tiles] of byDef) {
      const def = this.terrainDefs.get(id);
      const color = def?.color ?? '#7a7a7a';
      const h = def?.height ?? 0;
      const tall = !!def && (h >= 0.8 || (def.blocksSight && h >= 0.4));
      if (def?.model) {
        const template = buildModel(def.model, { lights: false });
        const ls = template.userData.light as { color: string; intensity: number; radius: number } | undefined;
        const animated = (def.model.idle ?? 'bob') !== 'none' && tiles.length <= 24;
        if (!animated) {
          // static terrain models: merge by material and instance (a few draw calls for any count)
          const turn = def.model.archetype === 'plant' || def.model.archetype === 'freeform';
          const entries: InstEntry[] = tiles.map((i) => ({
            tile: i,
            x: i % this.width,
            y: 0,
            z: Math.floor(i / this.width),
            color: new THREE.Color(1, 1, 1).multiplyScalar(0.94 + hash2(i, 31) * 0.1),
            rotY: turn ? hash2(i, 5) * Math.PI * 2 : 0,
          }));
          for (const part of mergeModel(template)) {
            const layer = new InstLayer(part.geometry, part.material, entries, `terrain:${id}`);
            layer.mesh.castShadow = true;
            layer.mesh.receiveShadow = true;
            this.terrainLayers.push(layer);
            this.terrainGroup.add(layer.mesh);
          }
          if (tall) for (const i of tiles) this.tallTerrain.add(i);
          if (ls && ls.intensity > 0) for (const i of tiles) this.lightSources.push({ pos: new THREE.Vector3(i % this.width, 0.8, Math.floor(i / this.width)), tile: i, ...ls });
          continue;
        }
        for (const i of tiles) {
          const m = template.clone();
          m.position.set(i % this.width, 0, Math.floor(i / this.width));
          m.rotation.y = def.model.archetype === 'plant' ? hash2(i, 5) * Math.PI * 2 : 0;
          m.visible = false;
          m.userData.tile = i;
          m.userData.tall = tall;
          m.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          this.terrainGroup.add(m);
          this.terrainModels.set(i, m);
          if (ls && ls.intensity > 0) this.lightSources.push({ pos: new THREE.Vector3(m.position.x, 0.8, m.position.z), tile: i, ...ls });
          if (tall) this.tallTerrain.add(i);
        }
      } else {
        const flat = h < 0.06;
        const geo = genericTerrainGeometry(h, def?.walkable !== false);
        const mat = getMaterial(def?.emissive ? 'matte' : 'stone', color, { emissive: def?.emissive, emissiveIntensity: def?.emissive ? 0.45 : undefined, opacity: flat ? 0.9 : undefined });
        const entries: InstEntry[] = tiles.map((i) => {
          const j = 0.9 + hash2(i, 9) * 0.18;
          const x = i % this.width;
          const z = Math.floor(i / this.width);
          return {
            tile: i,
            x,
            y: 0,
            z,
            color: new THREE.Color(j, j, j),
            sy: flat ? 1 : 0.85 + hash2(i, 21) * 0.3,
            sxz: flat ? 1 : 0.88 + hash2(i, 22) * 0.16,
            rotY: flat ? Math.floor(hash2(i, 23) * 4) * (Math.PI / 2) : (hash2(i, 24) - 0.5) * 0.8,
          };
        });
        const layer = new InstLayer(geo, mat, entries, `terrain:${id}`);
        layer.mesh.castShadow = !flat;
        if (flat) layer.mesh.renderOrder = 1;
        layer.mesh.receiveShadow = true;
        this.terrainLayers.push(layer);
        this.terrainGroup.add(layer.mesh);
        if (tall) for (const i of tiles) this.tallTerrain.add(i);
      }
    }
  }

  private doorOrientation(map: AreaMap, x: number, y: number): 'x' | 'z' {
    const wallX = (this.kindAt(map, x - 1, y) === 'wall' ? 1 : 0) + (this.kindAt(map, x + 1, y) === 'wall' ? 1 : 0);
    const wallZ = (this.kindAt(map, x, y - 1) === 'wall' ? 1 : 0) + (this.kindAt(map, x, y + 1) === 'wall' ? 1 : 0);
    return wallX >= wallZ ? 'x' : 'z';
  }

  private buildDoors(map: AreaMap): void {
    const wl = this.plan.wall;
    const sliding = wl.material === 'metal' || wl.material === 'glass';
    const doorColor = wl.color2 ? mixHex(wl.color2, wl.color, 0.25) : shade(wl.color, 0.7);
    const H = this.wallHeight;
    const doorH = Math.min(H * 0.92, 1.15);
    map.tiles.forEach((t, i) => {
      if (t.kind !== 'door' && t.kind !== 'door_open') return;
      const x = i % this.width;
      const y = Math.floor(i / this.width);
      const g = new THREE.Group();
      g.position.set(x, 0, y);
      if (this.doorOrientation(map, x, y) === 'z') g.rotation.y = Math.PI / 2;
      // lintel joins the walls above the door
      if (H - doorH > 0.05) g.add(prim('box', [1, H - doorH, 0.9], [0, doorH + (H - doorH) / 2, 0], shade(wl.color, 0.9), { material: wl.material }));
      for (const s of [-1, 1]) g.add(prim('box', [0.08, doorH, 0.3], [s * 0.46, doorH / 2, 0], shade(doorColor, 0.75), { material: wl.material === 'metal' ? 'metal' : 'wood' }));
      const hinge = new THREE.Group();
      hinge.position.set(-0.42, 0, 0);
      const panel = new THREE.Group();
      panel.add(prim('box', [0.84, doorH * 0.98, 0.07], [0.42, (doorH * 0.98) / 2, 0], doorColor, { material: sliding ? 'metal' : 'wood' }));
      panel.add(prim('box', [0.6, 0.06, 0.08], [0.42, doorH * 0.7, 0], shade(doorColor, 0.75), { material: sliding ? 'metal' : 'wood' }));
      panel.add(prim('box', [0.6, 0.06, 0.08], [0.42, doorH * 0.28, 0], shade(doorColor, 0.75), { material: sliding ? 'metal' : 'wood' }));
      panel.add(prim('sphere', [0.06, 0.06, 0.06], [0.72, doorH * 0.5, 0.05], '#d9c27a', { material: 'metal' }));
      hinge.add(panel);
      g.add(hinge);
      g.visible = false;
      this.group.add(g);
      const open = t.kind === 'door_open';
      const dv: DoorView = { obj: g, panel: sliding ? panel : hinge, open, sliding, k: open ? 1 : 0 };
      this.applyDoor(dv);
      this.doors.set(i, dv);
    });
  }

  private applyDoor(d: DoorView): void {
    if (d.sliding) d.panel.position.x = -0.8 * d.k;
    else d.panel.rotation.y = -1.45 * d.k;
  }

  private buildTransition(map: AreaMap): void {
    const ex = map.exit;
    if (!ex || ex.x < 0 || ex.y < 0 || ex.x >= map.width || ex.y >= map.height) return;
    this.exitIdx = this.idx(ex.x, ex.y);
    const g = new THREE.Group();
    g.name = 'transition';
    g.position.set(ex.x, 0, ex.y);
    const accent = this.world.palette?.accent ?? '#ffd166';
    // glowing ground ring always marks the way on
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.46, 32),
      new THREE.MeshBasicMaterial({ color: col(accent), transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.name = 'exit-ring';
    ring.userData.noDim = false;
    g.add(ring);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: col(accent), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(1.4, 1.4, 1.4);
    glow.position.y = 0.4;
    glow.name = 'exit-glow';
    g.add(glow);
    if (this.plan.transitionModel) {
      const m = buildModel(this.plan.transitionModel, { lights: false });
      m.name = 'exit-model';
      g.add(m);
      this.exitModel = m;
      const ls = m.userData.light as { color: string; intensity: number; radius: number } | undefined;
      if (ls && ls.intensity > 0) this.lightSources.push({ pos: new THREE.Vector3(ex.x, 0.8, ex.y), tile: this.exitIdx, ...ls });
    } else {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.38, 1.6, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: col(accent), transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
      );
      beam.position.y = 0.8;
      g.add(beam);
      const gem = prim('ico', [0.26, 0.36, 0.26], [0, 0.75, 0], accent, { material: 'glow' });
      gem.name = 'exit-gem';
      g.add(gem);
    }
    g.visible = false;
    this.transition = g;
    this.exitPos = new THREE.Vector3(ex.x, 0.6, ex.y);
    this.group.add(g);
  }

  private buildLamps(map: AreaMap): void {
    const lampCfg = this.plan.lighting?.lamps;
    const color = lampCfg?.color ?? '#ffcc88';
    const H = this.wallHeight;
    const metal = shade(this.plan.wall.color, 0.45);
    map.tiles.forEach((t, i) => {
      if (!t.lamp) return;
      const x = i % this.width;
      const y = Math.floor(i / this.width);
      const g = new THREE.Group();
      g.position.set(x, 0, y);
      let bulb: THREE.Vector3;
      // mount on an adjacent wall when there is one, otherwise a free-standing post
      let wallDir: [number, number] | null = null;
      if (t.kind === 'wall') wallDir = null;
      else
        for (const [ox, oy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
          if (this.kindAt(map, x + ox, y + oy) === 'wall') {
            wallDir = [ox, oy];
            break;
          }
        }
      const bulbH = Math.min(H * 0.72, 1.05);
      if (t.kind === 'wall') {
        bulb = new THREE.Vector3(0, H + 0.12, 0);
        g.add(prim('cylinder', [0.12, 0.08, 0.12], [0, H + 0.04, 0], metal, { material: 'metal' }));
      } else if (wallDir) {
        const [ox, oy] = wallDir;
        bulb = new THREE.Vector3(ox * 0.36, bulbH, oy * 0.36);
        g.add(prim('box', [ox ? 0.14 : 0.06, 0.05, oy ? 0.14 : 0.06], [ox * 0.44, bulbH - 0.08, oy * 0.44], metal, { material: 'metal' }));
        g.add(prim('cylinder', [0.08, 0.04, 0.08], [bulb.x, bulbH - 0.09, bulb.z], metal, { material: 'metal' }));
      } else {
        bulb = new THREE.Vector3(0, 1.0, 0);
        g.add(prim('cylinder', [0.05, 0.95, 0.05], [0, 0.475, 0], metal, { material: 'metal' }));
        g.add(prim('cylinder', [0.18, 0.04, 0.18], [0, 0.02, 0], metal, { material: 'metal' }));
      }
      const b = prim('sphere', [0.12, 0.14, 0.12], [bulb.x, bulb.y, bulb.z], color, { material: 'glow', castShadow: false });
      b.userData.noDim = false;
      g.add(b);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: col(color), transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.position.copy(bulb);
      glow.scale.setScalar(0.9);
      g.add(glow);
      g.visible = false;
      this.group.add(g);
      this.lamps.push({ tile: i, pos: bulb.clone().add(g.position), obj: g, glow, phase: hash2(x, y, 13) * 10, flicker: 1, visible: false });
    });
  }

  // -------------------------------------------------------------------------
  // Fog of war
  // -------------------------------------------------------------------------

  /** Apply per-tile visibility (0 unseen, 1 remembered, 2 visible). Only changed tiles are touched. */
  applySeen(seen: SeenArray): void {
    const n = Math.min(this.seen.length, seen.length);
    for (let i = 0; i < n; i++) {
      const s = seen[i] | 0;
      if (this.seen[i] === s) continue;
      this.seen[i] = s;
      this.floor?.setSeen(i, s);
      this.water?.setSeen(i, s);
      this.walls?.setSeen(i, s);
      if (this.lowered.has(i)) this.ghost?.setSeen(i, s);
      for (const l of this.terrainLayers) l.setSeen(i, s);
      const tm = this.terrainModels.get(i);
      if (tm) {
        tm.visible = s > 0;
        setDimmed(tm, s === 1);
      }
      const d = this.doors.get(i);
      if (d) {
        d.obj.visible = s > 0;
        setDimmed(d.obj, s === 1);
      }
      if (i === this.exitIdx && this.transition) {
        this.transition.visible = s > 0;
        setDimmed(this.transition, s === 1);
      }
    }
    for (const l of this.lamps) {
      // lamps are seen from afar: show once their tile or a neighbour has been seen
      const s = Math.max(this.seenAt(l.tile), this.neighbourSeen(l.tile));
      l.visible = s > 0;
      l.obj.visible = s > 0;
      setDimmed(l.obj, s === 1);
    }
  }

  private neighbourSeen(i: number): number {
    const x = i % this.width;
    const y = Math.floor(i / this.width);
    let best = 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
      const s = this.seen[ny * this.width + nx];
      if (s !== 255 && s > best) best = s;
    }
    return best;
  }

  seenAt(i: number): number {
    const s = this.seen[i];
    return s === 255 || s === undefined ? 0 : s;
  }

  isVisible(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.seenAt(this.idx(x, y)) === 2;
  }

  // -------------------------------------------------------------------------
  // Cut-away
  // -------------------------------------------------------------------------

  /**
   * True if the tile holds something tall enough to hide an actor on or behind it: a wall, tall
   * terrain, a door frame (lintel, posts and panel) or a transition model.
   */
  isTall(i: number): boolean {
    return (this.walls?.of.has(i) ?? false) || this.tallTerrain.has(i) || this.doors.has(i) || (i === this.exitIdx && !!this.exitModel);
  }

  /** Lower exactly the tiles in `set` (walls → stubs, tall terrain → squashed, doors and the transition model → flattened). */
  setCutaway(set: Set<number>): void {
    for (const i of this.lowered) if (!set.has(i)) this.lowerTile(i, false);
    for (const i of set) if (!this.lowered.has(i)) this.lowerTile(i, true);
    this.lowered = new Set(set);
  }

  private lowerTile(i: number, low: boolean): void {
    this.walls?.setScaleY(i, low ? LOWERED_HEIGHT / this.wallHeight : -1);
    this.ghost?.setSeen(i, low ? this.seenAt(i) : 0);
    for (const l of this.terrainLayers) l.setScaleY(i, low ? 0.2 : -1);
    const tm = this.terrainModels.get(i);
    if (tm) tm.scale.y = low ? 0.22 : 1;
    const d = this.doors.get(i);
    if (d) d.obj.scale.y = low ? LOWERED_HEIGHT / this.wallHeight : 1;
    if (i === this.exitIdx && this.exitModel) this.exitModel.scale.y = low ? 0.22 : 1;
  }

  /** current y scale of the door frame / transition model on a tile (1 = full height); for tests */
  propScaleY(i: number): number {
    const d = this.doors.get(i);
    if (d) return d.obj.scale.y;
    if (i === this.exitIdx && this.exitModel) return this.exitModel.scale.y;
    return 1;
  }

  get loweredTiles(): ReadonlySet<number> {
    return this.lowered;
  }

  /** for tests/debugging */
  inspect(i: number): { floor: number; wall: number; wallScale: number } {
    return { floor: this.floor?.seenState(i) ?? -1, wall: this.walls?.seenState(i) ?? -1, wallScale: this.walls?.scaleY(i) ?? 1 };
  }

  // -------------------------------------------------------------------------
  // Dynamic changes (doors opening, terrain spawning)
  // -------------------------------------------------------------------------

  /**
   * Reconcile with a new map state. Returns false if structural tiles changed (walls/floors) and the
   * whole view must be rebuilt.
   */
  updateTiles(map: AreaMap): boolean {
    if (map.width !== this.width || map.height !== this.height) return false;
    let terrainChanged = false;
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i];
      const k = tileKey(t);
      if (k === this.keys[i]) continue;
      const [oldKind, oldTerrain] = this.keys[i].split(':');
      this.keys[i] = k;
      const doorish = (s: string) => s === 'door' || s === 'door_open';
      if (oldKind !== t.kind) {
        if (doorish(oldKind) && doorish(t.kind)) {
          const d = this.doors.get(i);
          if (d) d.open = t.kind === 'door_open';
        } else {
          return false;
        }
      }
      if ((oldTerrain || undefined) !== t.terrain) terrainChanged = true;
    }
    if (terrainChanged) {
      this.buildTerrain(map);
      // re-apply visibility to the new terrain objects
      const seen = Array.from(this.seen, (s) => (s === 255 ? 0 : s));
      this.seen.fill(255);
      this.applySeen(seen);
      const low = this.lowered;
      this.lowered = new Set();
      this.setCutaway(low);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Per-frame animation
  // -------------------------------------------------------------------------

  update(t: number, dt: number): void {
    for (const d of this.doors.values()) {
      const target = d.open ? 1 : 0;
      if (d.k !== target) {
        d.k += Math.sign(target - d.k) * Math.min(Math.abs(target - d.k), dt * 6);
        this.applyDoor(d);
      }
    }
    for (const m of this.terrainModels.values()) if (m.visible) animateModel(m, t);
    if (this.transition?.visible) {
      const gem = this.transition.getObjectByName('exit-gem');
      if (gem) {
        gem.rotation.y = t * 1.5;
        gem.position.y = 0.75 + Math.sin(t * 2) * 0.08;
      }
      const model = this.transition.getObjectByName('exit-model');
      if (model) animateModel(model, t);
      const ring = this.transition.getObjectByName('exit-ring') as THREE.Mesh | undefined;
      if (ring) {
        const k = 1 + Math.sin(t * 2.4) * 0.06;
        ring.scale.set(k, k, k);
      }
    }
    if (this.waterTex) {
      this.waterTex.offset.x = (t * 0.03) % 1;
      this.waterTex.offset.y = (t * 0.017) % 1;
    }
    const lampCfg = this.plan.lighting?.lamps;
    for (const l of this.lamps) {
      if (!l.visible) continue;
      if (lampCfg?.flicker) {
        const p = l.phase;
        l.flicker = 0.78 + 0.14 * Math.sin(t * 9.1 + p) * Math.sin(t * 3.7 + p * 2) + 0.08 * Math.sin(t * 23 + p * 3);
      } else l.flicker = 1;
      (l.glow.material as THREE.SpriteMaterial).opacity = 0.45 * l.flicker * (this.seenAt(l.tile) === 1 ? 0.5 : 1);
    }
  }

  dispose(): void {
    this.floor?.dispose();
    this.water?.dispose();
    this.walls?.dispose();
    if (this.ghost) {
      (this.ghost.mesh.material as THREE.Material).dispose();
      this.ghost.dispose();
    }
    for (const l of this.terrainLayers) l.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.Sprite).isSprite) return;
      if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) if (mat && !mat.userData.cached && !mat.userData.dim) mat.dispose();
    });
    this.group.clear();
  }
}
