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
import { col, shade, mixHex, hash2, luminance } from './color';
import { buildModel, animateModel } from './models';
import { prim } from './models/geom';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { compactModel, mergeModel } from './models/merge';
import { towardCamera } from './coords';
import type { Pos } from '../../engine/types';
import {
  STUB_HEIGHT,
  wallStyleFor,
  renderedWallHeight,
  wallProfile,
  boxWallGeometry,
  blobWallGeometry,
  edgeBarGeometry,
  undersideGeometry,
  skirtGeometry,
  floatsOverVoid,
  isLiquidTerrain,
  rippleNormalTexture,
  PatchLayer,
  type WallStyle,
  type PatchTile,
} from './surfaces';

export const FLOOR_KINDS: ReadonlySet<TileKind> = new Set(['floor', 'start', 'door', 'door_open', 'transition']);

/** visibility per tile: 0 unseen, 1 remembered, 2 visible */
export type SeenArray = ArrayLike<number>;

const REMEMBER = new THREE.Color(0.36, 0.38, 0.48);
/** liquid terrain surface: matte (no glints) and see-through, like a 'water' floor */
export const LIQUID_TERRAIN_ROUGHNESS = 0.55;
export const LIQUID_TERRAIN_OPACITY = 0.72;
/**
 * Remembered (out of sight) walls: a darker, neutral body, so they never read as flat blue slabs
 * of the REMEMBER tint, while their top-edge outline stays close to full brightness (and glows a
 * little, see WALL_EDGE_GLOW) so corridors keep a crisp shape in the dark.
 */
export const REMEMBER_WALL = new THREE.Color(0.27, 0.28, 0.32);
export const REMEMBER_EDGE = new THREE.Color(0.8, 0.82, 0.9);
/** emissive share of the wall-edge outline colour (unlit, so it survives a dark backdrop) */
export const WALL_EDGE_GLOW = 0.35;
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
  private readonly drawn: Uint8Array;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  private readonly baseSy: Float32Array;
  private readonly rotY: Float32Array;
  private readonly sxz: Float32Array;
  /** height profile factor (eased towards profT) */
  private readonly prof: Float32Array;
  private readonly profT: Float32Array;
  private readonly moving = new Set<number>();

  /** tint multiplied into remembered (seen = 1) instances */
  private readonly remember: THREE.Color;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], entries: InstEntry[], name: string, remember: THREE.Color = REMEMBER) {
    this.remember = remember;
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
    this.drawn = new Uint8Array(n);
    this.prof = new Float32Array(n).fill(1);
    this.profT = new Float32Array(n).fill(1);
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
    this.mesh.visible = false;
  }

  /** instances currently drawn (seen state 1 or 2); the mesh is skipped entirely while none are */
  private live = 0;

  get liveCount(): number {
    return this.live;
  }

  private write(i: number): void {
    const st = this.state[i];
    const on = !(st === 0 || st === 255);
    if (on !== (this.drawn[i] === 1)) {
      this.drawn[i] = on ? 1 : 0;
      this.live += on ? 1 : -1;
      // no wasted vertex work on layers with nothing to show (wall ghosts, unexplored terrain kinds)
      this.mesh.visible = this.live > 0;
    }
    if (!on) {
      this.mesh.setMatrixAt(i, ZERO);
    } else {
      this.v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.s.set(this.sxz[i], this.sy[i] >= 0 ? this.sy[i] : this.baseSy[i] * this.prof[i], this.sxz[i]);
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
    if (this.state[i] === 1) this.c.multiply(this.remember);
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
    return i === undefined ? 1 : this.sy[i] >= 0 ? this.sy[i] : this.baseSy[i] * this.prof[i];
  }

  /** height profile target for an instance (eased in tick); `snap` applies it at once */
  setProfile(tile: number, f: number, snap = false): void {
    const i = this.of.get(tile);
    if (i === undefined) return;
    this.profT[i] = f;
    if (snap) {
      this.prof[i] = f;
      this.moving.delete(i);
      if (this.sy[i] < 0) this.write(i);
    } else if (this.prof[i] !== f) this.moving.add(i);
  }

  profile(tile: number): number {
    const i = this.of.get(tile);
    return i === undefined ? 1 : this.prof[i];
  }

  /** ease running height profiles; returns true while any is still moving */
  tick(dt: number): boolean {
    if (!this.moving.size) return false;
    const k = 1 - Math.exp(-dt * 8);
    for (const i of this.moving) {
      const t = this.profT[i];
      let p = this.prof[i] + (t - this.prof[i]) * k;
      if (Math.abs(t - p) < 0.004) {
        p = t;
        this.moving.delete(i);
      }
      this.prof[i] = p;
      if (this.sy[i] < 0) this.write(i);
    }
    return true;
  }

  /** set every instance's colour (base) at once, e.g. per-tile tints */
  setBaseColor(tile: number, c: THREE.Color): void {
    const i = this.of.get(tile);
    if (i === undefined) return;
    this.base.set([c.r, c.g, c.b], i * 3);
    if (this.state[i] !== 255) this.writeColor(i);
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
 * Generic terrain shape when a TerrainDef has no model and stands up from the floor (h ≥ 0.06; flat
 * terrain is a soft PatchLayer): a clump of rounded lumps for low walkable terrain, or a chamfered
 * block for tall / blocking terrain.
 */
function genericTerrainGeometry(h: number, walkable: boolean): THREE.BufferGeometry {
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
  // darker towards the floor, lit top: a block reads as a solid object, never as a pit
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = n.getY(i) > 0.5 ? 1.35 : 0.65 + 0.35 * (pos.getY(i) / h);
    c.set([v, v, v], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function tileKey(t: { kind: string; terrain?: string }): string {
  return `${t.kind}:${t.terrain ?? ''}`;
}

export class AreaView {
  readonly group = new THREE.Group();
  readonly width: number;
  readonly height: number;
  /** rendered wall height (plan.wall.height clamped to MAX_WALL_HEIGHT) */
  readonly wallHeight: number;
  /** the plan's own wall height (before clamping) */
  readonly planWallHeight: number;
  readonly wallStyle: WallStyle;
  readonly plan: AreaPlan;
  readonly world: WorldSpec;
  lamps: LampView[] = [];
  /** light-emitting terrain/transition models (position + light spec) for the light pool */
  lightSources: { pos: THREE.Vector3; tile: number; color: string; intensity: number; radius: number }[] = [];
  /** world position of the transition marker (if any) */
  exitPos: THREE.Vector3 | null = null;

  private floor: InstLayer | null = null;
  private water: PatchLayer | null = null;
  private waterBed: InstLayer | null = null;
  private walls: InstLayer | null = null;
  /** walls plus everything that follows their height (outline bars) */
  private wallLayers: InstLayer[] = [];
  private underside: InstLayer | null = null;
  private ghost: InstLayer | null = null;
  private terrainLayers: InstLayer[] = [];
  private patchLayers: PatchLayer[] = [];
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
  /** animated normal maps of liquid surfaces */
  private ripples = new Set<THREE.Texture>();
  private ownedMats: THREE.Material[] = [];
  private focusKey = '';
  /** freeze cosmetic animation (ripples) */
  reduceMotion = false;

  constructor(world: WorldSpec, plan: AreaPlan, area: AreaState) {
    this.world = world;
    this.plan = plan;
    const map = area.map;
    this.width = map.width;
    this.height = map.height;
    this.planWallHeight = plan.wall?.height ?? 1.4;
    this.wallHeight = renderedWallHeight(plan.wall?.height);
    this.wallStyle = wallStyleFor(plan.generator);
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

  private own<T extends THREE.Material>(m: T): T {
    m.userData.cached = false;
    m.userData.owned = true;
    this.ownedMats.push(m);
    return m;
  }

  /** a cached material copied so it can take vertex colours */
  private vcMat(kind: string | undefined, color: string, map: THREE.Texture | null): THREE.MeshStandardMaterial {
    const m = getMaterial(kind, map ? '#ffffff' : color, { map }).clone();
    m.vertexColors = true;
    return this.own(m);
  }

  /** chebyshev distance (≤ 4) from every tile to the nearest void tile or the map edge beyond void; 99 = far */
  private voidDistance(map: AreaMap): Uint8Array {
    const W = map.width;
    const H = map.height;
    const d = new Uint8Array(W * H).fill(99);
    const q: number[] = [];
    for (let i = 0; i < W * H; i++)
      if (map.tiles[i].kind === 'void') {
        d[i] = 0;
        q.push(i);
      }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (d[i] >= 4) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (d[j] <= d[i] + 1) continue;
          d[j] = d[i] + 1;
          q.push(j);
        }
    }
    return d;
  }

  private buildFloorsAndWalls(map: AreaMap): void {
    const plan = this.plan;
    const fl = plan.floor;
    const wl = plan.wall;
    const H = this.wallHeight;
    const style = this.wallStyle;
    const W = map.width;

    // --- floors ---
    const gradient = fl.pattern === 'gradient';
    const floorTex = gradient ? null : patternTexture(fl.pattern ?? 'plain', fl.color, fl.color2, 11);
    const floorTop = getMaterial(fl.material === 'glow' ? 'matte' : fl.material, floorTex || gradient ? '#ffffff' : fl.color, {
      map: floorTex,
      emissive: fl.material === 'glow' ? shade(fl.color, 0.6) : undefined,
      emissiveIntensity: fl.material === 'glow' ? 0.35 : undefined,
    });
    const floorSide = getMaterial('stone', shade(fl.color, 0.55));
    const floorGeo = new THREE.BoxGeometry(1, 0.2, 1);
    floorGeo.translate(0, -0.1, 0);
    const floorEntries: InstEntry[] = [];
    const bedEntries: InstEntry[] = [];
    const waterTiles: PatchTile[] = [];
    const wallEntries: InstEntry[] = [];
    const edgeEntries: InstEntry[][] = [[], [], [], []];
    const underEntries: InstEntry[] = [];
    const voidD = this.voidDistance(map);
    const floating = floatsOverVoid(plan.generator);
    const fc1 = col(fl.color);
    const fc2 = col(fl.color2 ?? shade(fl.color, 0.75));
    const wc1 = col(wl.color);
    const wc2 = col(wl.color2 ?? shade(wl.color, 0.8));
    const isWall = (x: number, y: number) => this.kindAt(map, x, y) === 'wall';
    // low-frequency blotches for organic colour variation
    const blotch = (x: number, y: number) => 0.5 + 0.25 * Math.sin(x * 0.55 + Math.sin(y * 0.4) * 1.7) + 0.25 * Math.sin(y * 0.47 - x * 0.21 + 1.1);
    const tint = (x: number, y: number): THREE.Color => {
      if (gradient) {
        const t = Math.max(0, Math.min(1, (x / Math.max(1, W - 1)) * 0.55 + (y / Math.max(1, map.height - 1)) * 0.45 + (blotch(x, y) - 0.5) * 0.25));
        return fc1.clone().lerp(fc2, t);
      }
      return new THREE.Color(1, 1, 1);
    };
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = this.idx(x, y);
        const t = map.tiles[i];
        const vd = voidD[i];
        if (FLOOR_KINDS.has(t.kind)) {
          let j = 0.93 + hash2(x, y) * 0.12;
          if (style === 'blob') j *= 0.86 + blotch(x, y) * 0.26;
          // soft contact shadow next to walls
          let nearWall = 0;
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWall(x + ox, y + oy)) nearWall++;
          j *= 1 - Math.min(2, nearWall) * 0.07;
          floorEntries.push({ tile: i, x, y: 0, z: y, color: tint(x, y).multiplyScalar(j), sxz: style === 'crisp' ? 0.94 : 1 });
        } else if (t.kind === 'water') {
          const j = 0.75 + hash2(x, y, 3) * 0.1;
          bedEntries.push({ tile: i, x, y: -0.16, z: y, color: new THREE.Color(j, j, j) });
          waterTiles.push({ tile: i, x, y });
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
            let c: THREE.Color;
            let sy = 1;
            let rotY = 0;
            let sxz = 1;
            if (style === 'blob') {
              c = wc1.clone().lerp(wc2, Math.min(1, blotch(x, y) * 0.8 + hash2(x, y, 41) * 0.3)).multiplyScalar(0.9 + hash2(x, y, 7) * 0.2);
              sy = 0.62 + hash2(x, y, 17) * 0.38;
              rotY = hash2(x, y, 19) * Math.PI * 2;
              sxz = 0.9 + hash2(x, y, 23) * 0.16;
              // ground under the blobs so the gaps between them are not holes
              floorEntries.push({ tile: i, x, y: 0, z: y, color: tint(x, y).multiplyScalar(0.7) });
            } else {
              const j = 0.9 + hash2(x, y, 7) * 0.14;
              c = new THREE.Color(j, j, j);
              if (style === 'rough') sy = 0.82 + hash2(x, y, 17) * 0.3;
            }
            wallEntries.push({ tile: i, x, y: 0, z: y, color: c, sy, rotY, sxz });
            if (style !== 'blob') {
              // outline bars on the top edges that face open ground (N, E, S, W)
              const dirs: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
              dirs.forEach(([ox, oy], k) => {
                const nk = this.kindAt(map, x + ox, y + oy);
                if (nk !== null && nk !== 'wall') edgeEntries[k].push({ tile: i, x, y: 0, z: y, color: new THREE.Color(1, 1, 1), sy, rotY: -k * (Math.PI / 2) });
              });
            }
          }
        }
        // floating-platform undersides along void edges
        if (t.kind !== 'void' && vd <= (floating ? 3 : 1) && (FLOOR_KINDS.has(t.kind) || t.kind === 'water' || (t.kind === 'wall' && wallEntries.at(-1)?.tile === i))) {
          const j = 0.8 + hash2(x, y, 53) * 0.25;
          if (floating) {
            const depth = 0.7 + vd * 0.65 + hash2(x, y, 51) * 0.8;
            underEntries.push({ tile: i, x, y: -0.2, z: y, color: new THREE.Color(j, j, j), sy: depth, rotY: Math.floor(hash2(x, y, 55) * 4) * (Math.PI / 2), sxz: 0.94 + hash2(x, y, 57) * 0.1 });
          } else underEntries.push({ tile: i, x, y: -0.2, z: y, color: new THREE.Color(j, j, j), sy: 0.9 });
        }
      }
    }
    this.floor = new InstLayer(floorGeo, [floorSide, floorSide, floorTop, floorSide, floorSide, floorSide], floorEntries, 'floor');
    this.floor.mesh.receiveShadow = true;
    this.group.add(this.floor.mesh);

    if (underEntries.length) {
      const rock = mixHex(shade(fl.color, 0.6), shade(wl.color, 0.7), 0.5);
      const glow = plan.backdrop?.color2 ?? plan.lighting?.lamps?.color;
      const mat = this.own(new THREE.MeshStandardMaterial({ color: col(rock), roughness: 0.95, flatShading: true, vertexColors: true }));
      if (glow && floating) {
        mat.emissive = col(glow);
        mat.emissiveIntensity = 0.12;
      }
      this.underside = new InstLayer(floating ? undersideGeometry() : skirtGeometry(), mat, underEntries, 'underside');
      this.underside.mesh.receiveShadow = true;
      this.group.add(this.underside.mesh);
    }

    if (waterTiles.length) {
      const wcol = fl.pattern === 'water' ? fl.color : mixHex('#2d6f93', fl.color, 0.2);
      const bed = getMaterial('stone', shade(mixHex(fl.color, wcol, 0.5), 0.55));
      const bedGeo = new THREE.BoxGeometry(1, 0.2, 1);
      bedGeo.translate(0, -0.1, 0);
      this.waterBed = new InstLayer(bedGeo, bed, bedEntries, 'water-bed');
      this.waterBed.mesh.receiveShadow = true;
      this.group.add(this.waterBed.mesh);
      const set = new Set(waterTiles.map((t) => t.tile));
      this.water = new PatchLayer(waterTiles, (x, y) => x >= 0 && y >= 0 && x < W && y < map.height && set.has(y * W + x), this.liquidMaterial(wcol, 0.84), -0.05, 'water', 0.35);
      this.water.mesh.renderOrder = 2;
      this.group.add(this.water.mesh);
    }

    // --- walls ---
    const wallKind = wl.material === 'glow' ? 'matte' : wl.material;
    const capColor = this.capColor();
    let wallGeo: THREE.BufferGeometry;
    let wallMat: THREE.Material | THREE.Material[];
    if (style === 'blob') {
      wallGeo = blobWallGeometry(H);
      const m = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.0, vertexColors: true }));
      if (wl.material === 'glow') {
        m.emissive = col(wl.color2 ?? wl.color);
        m.emissiveIntensity = 0.25;
      }
      wallMat = m;
    } else {
      wallGeo = boxWallGeometry(H);
      // tall plans keep a deeper base shade instead of extra height
      if (this.planWallHeight > H + 0.05) {
        const c = wallGeo.getAttribute('color') as THREE.BufferAttribute;
        for (let k = 0; k < c.count; k++) if (c.getX(k) < 1) c.setXYZ(k, c.getX(k) * 0.88, c.getY(k) * 0.88, c.getZ(k) * 0.88);
      }
      const wallTex = patternTexture(wl.pattern ?? 'plain', wl.color, wl.color2, 23);
      const side = this.vcMat(wallKind, wl.color, wallTex);
      if (wl.material === 'glow') {
        side.emissive = col(wl.color);
        side.emissiveIntensity = 0.4;
      }
      if (style === 'crisp') side.flatShading = true;
      const top = this.vcMat(style === 'crisp' ? 'matte' : 'matte', capColor, null);
      top.roughness = 0.7;
      wallMat = [side, side, top, top, side, side];
    }
    this.walls = new InstLayer(wallGeo, wallMat, wallEntries, 'walls', REMEMBER_WALL);
    this.walls.mesh.castShadow = true;
    this.walls.mesh.receiveShadow = true;
    this.group.add(this.walls.mesh);
    this.wallLayers = [this.walls];

    if (style !== 'blob') {
      let edgeMat: THREE.Material;
      if (style === 'crisp') {
        const glowC = wl.color2 && luminance(wl.color2) > luminance(wl.color) ? shade(wl.color2, 1.25) : shade(this.world.palette?.accent ?? '#9be7ff', 1.1);
        edgeMat = this.own(new THREE.MeshBasicMaterial({ color: col(glowC), toneMapped: false }));
      } else {
        const edgeC = shade(capColor, 1.3);
        edgeMat = this.own(new THREE.MeshStandardMaterial({ color: col(edgeC), roughness: 0.6, emissive: col(edgeC), emissiveIntensity: WALL_EDGE_GLOW }));
      }
      const edgeGeo = edgeBarGeometry(H, style === 'crisp' ? 0.045 : 0.05);
      edgeEntries.forEach((entries, k) => {
        if (!entries.length) return;
        const layer = new InstLayer(edgeGeo.clone(), edgeMat, entries, `wall-edges-${k}`, REMEMBER_EDGE);
        this.group.add(layer.mesh);
        this.wallLayers.push(layer);
      });
      edgeGeo.dispose();
    }

    // translucent full-height copies shown over lowered (cut-away) walls so rooms keep their shape
    const ghostMat = this.own(new THREE.MeshStandardMaterial({ color: col(wl.color), transparent: true, opacity: 0.12, depthWrite: false, roughness: 1 }));
    this.ghost = new InstLayer(wallGeo.clone(), ghostMat, wallEntries, 'wall-ghosts');
    this.ghost.mesh.renderOrder = 5;
    this.group.add(this.ghost.mesh);
  }

  /** wall cap: a lighter tone of the wall (color2 leaning), kept apart from the floor's lightness */
  private capColor(): string {
    const wl = this.plan.wall;
    // what the side faces look like on average (line/grid/noise patterns are dominated by color2)
    const busy = wl.pattern === 'lines' || wl.pattern === 'grid' || wl.pattern === 'noise' || wl.pattern === 'gradient';
    const side = busy ? mixHex(wl.color, wl.color2 ?? wl.color, 0.45) : wl.color;
    let cap = shade(mixHex(side, wl.color2 ?? side, 0.3), 1.25);
    // the cap must read as the lit top of the wall, never as a hole: at least as light as the sides
    for (let k = 0; k < 4 && luminance(cap) < luminance(side) * 1.08 + 0.02; k++) cap = shade(cap, 1.2);
    const lf = luminance(this.plan.floor.color);
    if (Math.abs(luminance(cap) - lf) < 0.08) cap = lf > 0.5 ? shade(cap, 0.75) : shade(cap, 1.3);
    return cap;
  }

  /** shiny translucent liquid with drifting ripples */
  private liquidMaterial(color: string, opacity: number): THREE.MeshStandardMaterial {
    const ripple = rippleNormalTexture();
    const m = this.own(
      new THREE.MeshStandardMaterial({
        color: col(color),
        roughness: 0.12,
        metalness: 0.05,
        transparent: true,
        opacity,
        depthWrite: false,
        vertexColors: true,
        emissive: col(shade(color, 0.6)),
        emissiveIntensity: 0.18,
      }),
    );
    if (ripple) {
      const r = ripple.clone();
      r.needsUpdate = true;
      r.repeat.set(1, 1);
      m.normalMap = r;
      m.normalScale = new THREE.Vector2(0.55, 0.55);
      this.ripples.add(r);
    }
    return m;
  }

  /**
   * Liquid terrain (puddles, seeps, floods, spills): the same flat surface and ripple-arc pattern as
   * a 'water' floor, slowly drifting, matte enough that no specular glints sparkle on it, and
   * translucent so the floor shows through at its soft border.
   */
  private flatLiquidMaterial(color: string, emissive?: string): THREE.MeshStandardMaterial {
    const pat = patternTexture('water', color, shade(color, 0.8), 13);
    let map: THREE.Texture | null = null;
    if (pat) {
      map = pat.clone();
      map.needsUpdate = true;
      this.ripples.add(map);
    }
    const m = new THREE.MeshStandardMaterial({
      color: map ? 0xffffff : col(color),
      map,
      roughness: LIQUID_TERRAIN_ROUGHNESS,
      metalness: 0,
      transparent: true,
      opacity: LIQUID_TERRAIN_OPACITY,
      depthWrite: false,
      vertexColors: true,
      emissive: col(emissive ?? shade(color, 0.5)),
      emissiveIntensity: emissive ? 0.3 : 0.1,
    });
    m.name = 'liquid-terrain';
    return this.own(m);
  }

  private buildTerrain(map: AreaMap): void {
    for (const l of this.terrainLayers) {
      this.terrainGroup.remove(l.mesh);
      l.dispose();
    }
    this.terrainLayers = [];
    for (const l of this.patchLayers) {
      this.terrainGroup.remove(l.mesh);
      l.dispose();
    }
    this.patchLayers = [];
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
      // tall terrain never towers over the (clamped) walls
      const h = Math.min(def?.height ?? 0, this.wallHeight + 0.1);
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
        // animated terrain models keep their moving parts but merge everything rigid per material
        // (compactModel), so each placed copy costs a few draw calls instead of one per primitive
        template.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        compactModel(template);
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
      } else if (h < 0.06) {
        // flat terrain: a soft-edged patch (liquids shine and ripple), never a hard-edged flat quad
        const set = new Set(tiles);
        const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < this.width && y < this.height && set.has(y * this.width + x);
        const ptiles = tiles.map((i) => ({ tile: i, x: i % this.width, y: Math.floor(i / this.width) }));
        let mat: THREE.Material;
        if (isLiquidTerrain(def)) {
          mat = this.patchMaterial(`liquid:${id}`, () => this.flatLiquidMaterial(color, def?.emissive));
        } else {
          mat = this.patchMaterial(`patch:${id}`, () => {
            const tex = patternTexture('noise', color, shade(color, 0.8), 3);
            const m = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : col(color), map: tex, roughness: 0.9, transparent: true, opacity: 0.92, depthWrite: false, vertexColors: true });
            if (def?.emissive) {
              m.emissive = col(def.emissive);
              m.emissiveIntensity = 0.45;
            }
            return this.own(m);
          });
        }
        const layer = new PatchLayer(ptiles, inside, mat, 0.012 + Math.max(0, h) * 0.5, `terrain:${id}`, 0.5, 0.12);
        layer.mesh.renderOrder = 1;
        layer.mesh.receiveShadow = true;
        this.patchLayers.push(layer);
        this.terrainGroup.add(layer.mesh);
      } else {
        const geo = genericTerrainGeometry(h, def?.walkable !== false);
        let mat: THREE.Material = getMaterial(def?.emissive ? 'matte' : 'stone', color, { emissive: def?.emissive, emissiveIntensity: def?.emissive ? 0.45 : undefined });
        if (geo.getAttribute('color')) {
          mat = this.patchMaterial(`block:${id}`, () => {
            const m = (mat as THREE.MeshStandardMaterial).clone();
            m.vertexColors = true;
            return this.own(m);
          });
        }
        const entries: InstEntry[] = tiles.map((i) => {
          const j = 0.9 + hash2(i, 9) * 0.18;
          return {
            tile: i,
            x: i % this.width,
            y: 0,
            z: Math.floor(i / this.width),
            color: new THREE.Color(j, j, j),
            sy: 0.85 + hash2(i, 21) * 0.3,
            sxz: 0.88 + hash2(i, 22) * 0.16,
            rotY: (hash2(i, 24) - 0.5) * 0.8,
          };
        });
        const layer = new InstLayer(geo, mat, entries, `terrain:${id}`);
        layer.mesh.castShadow = true;
        layer.mesh.receiveShadow = true;
        this.terrainLayers.push(layer);
        this.terrainGroup.add(layer.mesh);
        if (tall) for (const i of tiles) this.tallTerrain.add(i);
      }
    }
  }

  private patchMats = new Map<string, THREE.Material>();
  private patchMaterial(key: string, make: () => THREE.Material): THREE.Material {
    let m = this.patchMats.get(key);
    if (!m) {
      m = make();
      this.patchMats.set(key, m);
    }
    return m;
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
      // threshold plate: marks the doorway even when the frame is cut down to a stub
      // (same colour and material as the jambs, so compactModel merges them into one draw call)
      g.add(prim('box', [0.96, 0.03, 0.42], [0, 0.015, 0], shade(doorColor, 1.1), { material: wl.material === 'metal' ? 'metal' : 'wood' }));
      // lintel joins the walls above the door
      if (H - doorH > 0.05) g.add(prim('box', [1, H - doorH, 0.9], [0, doorH + (H - doorH) / 2, 0], shade(wl.color, 0.9), { material: wl.material }));
      for (const s of [-1, 1]) g.add(prim('box', [0.1, doorH, 0.34], [s * 0.46, doorH / 2, 0], shade(doorColor, 1.1), { material: wl.material === 'metal' ? 'metal' : 'wood' }));
      const hinge = new THREE.Group();
      hinge.position.set(-0.42, 0, 0);
      const panel = new THREE.Group();
      panel.add(prim('box', [0.84, doorH * 0.98, 0.07], [0.42, (doorH * 0.98) / 2, 0], doorColor, { material: sliding ? 'metal' : 'wood' }));
      panel.add(prim('box', [0.6, 0.06, 0.08], [0.42, doorH * 0.7, 0], shade(doorColor, 0.75), { material: sliding ? 'metal' : 'wood' }));
      panel.add(prim('box', [0.6, 0.06, 0.08], [0.42, doorH * 0.28, 0], shade(doorColor, 0.75), { material: sliding ? 'metal' : 'wood' }));
      panel.add(prim('sphere', [0.06, 0.06, 0.06], [0.72, doorH * 0.5, 0.05], '#d9c27a', { material: 'metal' }));
      hinge.add(panel);
      g.add(hinge);
      // frame parts merge per material into the door group, panel parts into the moving panel
      compactModel(g, { isRigid: (o) => o === g || o === hinge || o === panel });
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
      this.water?.setSeen(i, s, REMEMBER);
      this.waterBed?.setSeen(i, s);
      this.underside?.setSeen(i, s);
      for (const l of this.wallLayers) l.setSeen(i, s);
      if (this.lowered.has(i)) this.ghost?.setSeen(i, s);
      for (const l of this.terrainLayers) l.setSeen(i, s);
      for (const l of this.patchLayers) l.setSeen(i, s, REMEMBER);
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
    for (const l of this.wallLayers) l.setScaleY(i, low ? STUB_HEIGHT / this.wallHeight : -1);
    this.ghost?.setSeen(i, low ? this.seenAt(i) : 0);
    for (const l of this.terrainLayers) l.setScaleY(i, low ? 0.2 : -1);
    const tm = this.terrainModels.get(i);
    if (tm) tm.scale.y = low ? 0.22 : 1;
    const d = this.doors.get(i);
    if (d) d.obj.scale.y = low ? STUB_HEIGHT / this.wallHeight : 1;
    if (i === this.exitIdx && this.exitModel) this.exitModel.scale.y = low ? 0.22 : 1;
  }

  /**
   * Height profile around the player: walls more than PROFILE_NEAR rows in front of or behind the
   * player (camera depth) ease down to PROFILE_FAR of their height, so distant walls never wall off
   * the view. Cheap to call every frame (only recomputes when the tile or camera step changes).
   */
  setFocus(p: Pos, yawStep: number, snap = false): void {
    const key = `${p.x},${p.y},${yawStep}`;
    if (key === this.focusKey && !snap) return;
    const first = this.focusKey === '';
    this.focusKey = key;
    const { dx: cx, dy: cy } = towardCamera(yawStep);
    for (const layer of this.wallLayers)
      for (const tile of layer.tiles) {
        const d = ((tile % this.width) - p.x) * cx + (Math.floor(tile / this.width) - p.y) * cy;
        layer.setProfile(tile, wallProfile(d), snap || first);
      }
  }

  /** current height profile factor of a wall tile (1 = full); for tests */
  wallProfileAt(i: number): number {
    return this.walls?.profile(i) ?? 1;
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
  inspect(i: number): { floor: number; wall: number; wallScale: number; water: number; underside: number } {
    return {
      floor: this.floor?.seenState(i) ?? -1,
      wall: this.walls?.seenState(i) ?? -1,
      wallScale: this.walls?.scaleY(i) ?? 1,
      water: this.water?.seenState(i) ?? -1,
      underside: this.underside?.seenState(i) ?? -1,
    };
  }

  /** layer names and instance/tile counts; for tests and the dev page */
  /**
   * Luminance of a remembered wall's cap, its top-edge outline and the remembered floor, from the
   * materials and remembered tints (lighting aside). For tests: the outline must stand out from the
   * cap and the cap from the floor. Null when the walls have no outline (blob style).
   */
  rememberedContrast(): { cap: number; edge: number; floor: number; edgeVsCap: number; capVsFloor: number } | null {
    const edges = this.wallLayers.find((l) => l.mesh.name.startsWith('wall-edges'));
    if (!edges || !this.walls) return null;
    const mats = this.walls.mesh.material as THREE.Material[] | THREE.Material;
    const top = (Array.isArray(mats) ? mats[2] : mats) as THREE.MeshStandardMaterial;
    const em = edges.mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    const lum = (c: THREE.Color) => luminance('#' + c.getHexString());
    const cap = lum(top.color.clone().multiply(REMEMBER_WALL));
    let edgeC = em.color.clone().multiply(REMEMBER_EDGE);
    if ('emissive' in em && em.emissive) edgeC = edgeC.add(em.emissive.clone().multiplyScalar(em.emissiveIntensity));
    const edge = lum(edgeC);
    const floor = lum(col(this.plan.floor.color).multiply(REMEMBER));
    return { cap, edge, floor, edgeVsCap: edge - cap, capVsFloor: cap - floor };
  }

  /** liquid terrain patches: material and geometry facts, for tests */
  liquidTerrainInfo(): { name: string; roughness: number; opacity: number; normalMap: boolean; folded: number }[] {
    const out: { name: string; roughness: number; opacity: number; normalMap: boolean; folded: number }[] = [];
    for (const l of this.patchLayers) {
      const m = l.mesh.material as THREE.MeshStandardMaterial;
      if (m.name !== 'liquid-terrain') continue;
      out.push({ name: l.mesh.name, roughness: m.roughness, opacity: m.opacity, normalMap: !!m.normalMap, folded: l.foldedTriangles() });
    }
    return out;
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of [this.floor, this.waterBed, this.underside, this.ghost, ...this.wallLayers, ...this.terrainLayers]) if (l) out[l.mesh.name] = (out[l.mesh.name] ?? 0) + l.tiles.length;
    for (const l of [this.water, ...this.patchLayers]) if (l) out[l.mesh.name] = (out[l.mesh.name] ?? 0) + l.of.size;
    return out;
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
    for (const l of this.wallLayers) l.tick(dt);
    if (!this.reduceMotion)
      for (const r of this.ripples) {
        r.offset.x = (t * 0.045) % 1;
        r.offset.y = (t * 0.027) % 1;
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
    this.waterBed?.dispose();
    this.underside?.dispose();
    for (const l of this.wallLayers) l.dispose();
    this.ghost?.dispose();
    for (const l of this.terrainLayers) l.dispose();
    for (const l of this.patchLayers) l.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const r of this.ripples) r.dispose();
    this.ripples.clear();
    this.ownedMats = [];
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
