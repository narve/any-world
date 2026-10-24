/**
 * Geometry and helpers for area surfaces: wall shapes per layout family, wall-top outlines, floating
 * platform undersides, soft-edged liquid / patch surfaces and the rules that pick between them.
 * Pure three.js (works in node for unit tests; textures are skipped there).
 */
import * as THREE from 'three';
import type { Generator, TerrainDef } from '../../schema/world';
import { hash2 } from './color';
import { hasCanvas } from './textures';

/** Rendered walls never exceed this (tiles); taller plans keep their feel through colour, not geometry. */
export const MAX_WALL_HEIGHT = 1.15;
/** height of a cut-away wall stub (tiles) */
export const STUB_HEIGHT = 0.25;
/** walls farther than this (camera depth, tiles) from the player are drawn lower */
export const PROFILE_NEAR = 2;
/** height factor of walls beyond PROFILE_NEAR */
export const PROFILE_FAR = 0.7;

export type WallStyle = 'box' | 'rough' | 'blob' | 'crisp';

/** Wall look for a layout generator. */
export function wallStyleFor(generator: Generator | string): WallStyle {
  switch (generator) {
    case 'organic':
      return 'blob';
    case 'geometric':
      return 'crisp';
    case 'caves':
    case 'open':
      return 'rough';
    default:
      return 'box';
  }
}

/** Rendered wall height for a plan's requested height (default 1.4). */
export function renderedWallHeight(planHeight: number | undefined): number {
  const h = planHeight ?? 1.4;
  return Math.max(0.2, Math.min(MAX_WALL_HEIGHT, h));
}

/**
 * Height factor for a wall at camera depth `d` from the player (d > 0: towards the camera, in tiles).
 * Walls right around the player keep their full height; walls farther than PROFILE_NEAR rows in
 * front of or behind the player drop to PROFILE_FAR so they do not wall off the view.
 */
export function wallProfile(d: number): number {
  if (d >= PROFILE_NEAR) return PROFILE_FAR;
  if (d <= -(PROFILE_NEAR + 1)) return PROFILE_FAR;
  if (d < -PROFILE_NEAR) return 1 - (1 - PROFILE_FAR) * (-PROFILE_NEAR - d);
  return 1;
}

// ---------------------------------------------------------------------------
// Liquids
// ---------------------------------------------------------------------------

const LIQUID_WORDS = /(water|flood|seep|puddle|pool|leak|coolant|liquid|spill|ooze|slime|acid|lava|magma|oil|tar|bog|swamp|marsh|mud|brine|blood|ichor|sap|honey|wet|mopp?ed|drip|tide|rain|melt|goo|sludge|bile|plasma|mercury|ink|wine|syrup)/i;

/** A flat terrain that is (by its words) some kind of liquid: drawn as a soft shiny surface. */
export function isLiquidTerrain(def: Pick<TerrainDef, 'id' | 'name' | 'height'> | undefined): boolean {
  if (!def) return false;
  if ((def.height ?? 0) >= 0.06) return false;
  return LIQUID_WORDS.test(def.id) || LIQUID_WORDS.test(def.name);
}

/**
 * Alpha at a point of a soft patch: `inside(dx, dy)` says whether the neighbouring tile belongs to
 * the same patch. Vertices are on a 3×3 grid per tile (u, v ∈ {0, 0.5, 1}); a point's coverage is the
 * share of the tiles touching it that belong to the patch, so patch borders fade out while shared
 * edges between two patch tiles stay solid.
 */
export function patchAlpha(u: number, v: number, inside: (dx: number, dy: number) => boolean): number {
  const xs = u === 0 ? [-1, 0] : u === 1 ? [0, 1] : [0];
  const ys = v === 0 ? [-1, 0] : v === 1 ? [0, 1] : [0];
  let n = 0;
  let k = 0;
  for (const oy of ys)
    for (const ox of xs) {
      n++;
      if (ox === 0 && oy === 0) k++;
      else if (inside(ox, oy)) k++;
    }
  const cov = k / n;
  // 1 → solid, 0.5 (outer edge of a patch) → soft, 0.25 (outer corner) → faint
  return Math.min(1, Math.max(0, cov * cov * 1.25 - 0.05));
}

/**
 * Outward push (−1, 0 or 1 per axis, times the layer's pad) of a patch vertex so its soft border
 * overlaps the floor. A vertex moves along an axis only when every tile beyond it on that axis is
 * outside the patch, so the push depends on the vertex's grid point and never on which tile builds
 * it: neighbouring tiles agree on shared vertices, and no triangle folds over its neighbour (the
 * folds were what drew liquid patches as spiky stars).
 */
export function patchGrow(u: number, v: number, inside: (dx: number, dy: number) => boolean): [number, number] {
  const sx = u === 0 ? -1 : u === 1 ? 1 : 0;
  const sz = v === 0 ? -1 : v === 1 ? 1 : 0;
  // the column (row) of tiles on the far side of the vertex along x (z)
  const gx = sx !== 0 && !inside(sx, 0) && (sz === 0 || !inside(sx, sz)) ? sx : 0;
  const gz = sz !== 0 && !inside(0, sz) && (sx === 0 || !inside(sx, sz)) ? sz : 0;
  return [gx, gz];
}

export interface PatchTile {
  tile: number;
  x: number;
  y: number;
}

/**
 * One merged mesh for a set of tiles: a 3×3-vertex quad per tile with per-vertex RGBA colours, so
 * visibility per tile (RGB multiplier, alpha 0 when unseen) and soft borders (alpha) can be set
 * without instancing. UVs are world-space so textures run on across tiles.
 */
export class PatchLayer {
  readonly mesh: THREE.Mesh;
  readonly of = new Map<number, number>();
  private readonly base: Float32Array;
  private readonly colors: THREE.BufferAttribute;
  private readonly state: Uint8Array;

  constructor(tiles: PatchTile[], inside: (x: number, y: number) => boolean, material: THREE.Material, y: number, name: string, uvScale = 0.5, pad = 0) {
    const n = tiles.length;
    const pos = new Float32Array(n * 9 * 3);
    const uv = new Float32Array(n * 9 * 2);
    const nrm = new Float32Array(n * 9 * 3);
    const colr = new Float32Array(n * 9 * 4);
    this.base = new Float32Array(n * 9);
    const index: number[] = [];
    tiles.forEach((t, i) => {
      this.of.set(t.tile, i);
      for (let vy = 0; vy < 3; vy++)
        for (let vx = 0; vx < 3; vx++) {
          const k = i * 9 + vy * 3 + vx;
          const u = vx / 2;
          const v = vy / 2;
          // border vertices of the patch reach slightly beyond the tile so the fade overlaps the floor
          const a = patchAlpha(u, v, (dx, dy) => inside(t.x + dx, t.y + dy));
          const [gx, gz] = patchGrow(u, v, (dx, dy) => inside(t.x + dx, t.y + dy));
          const px = t.x - 0.5 + u + gx * pad;
          const pz = t.y - 0.5 + v + gz * pad;
          pos.set([px, y, pz], k * 3);
          uv.set([px * uvScale, pz * uvScale], k * 2);
          nrm.set([0, 1, 0], k * 3);
          this.base[k] = a;
          colr.set([1, 1, 1, 0], k * 4);
        }
      const b = i * 9;
      for (let qy = 0; qy < 2; qy++)
        for (let qx = 0; qx < 2; qx++) {
          const a = b + qy * 3 + qx;
          index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
        }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.colors = new THREE.BufferAttribute(colr, 4);
    geo.setAttribute('color', this.colors);
    geo.setIndex(index);
    if (n > 0) geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.state = new Uint8Array(n).fill(255);
  }

  /** visibility of one tile: 0 hidden, 1 remembered (dimmed), 2 visible */
  setSeen(tile: number, st: number, remember: THREE.Color): void {
    const i = this.of.get(tile);
    if (i === undefined || this.state[i] === st) return;
    this.state[i] = st;
    const arr = this.colors.array as Float32Array;
    for (let k = i * 9; k < i * 9 + 9; k++) {
      const a = st === 0 ? 0 : this.base[k];
      if (st === 1) arr.set([remember.r, remember.g, remember.b, a * 0.8], k * 4);
      else arr.set([1, 1, 1, a], k * 4);
    }
    this.colors.needsUpdate = true;
  }

  seenState(tile: number): number {
    const i = this.of.get(tile);
    return i === undefined ? -1 : this.state[i];
  }

  /**
   * Triangles whose winding (seen from above) is flipped or degenerate: a pushed-out border vertex
   * crossing over its neighbour folds a triangle back over the patch. 0 for a clean patch.
   */
  foldedTriangles(): number {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    const idx = geo.getIndex();
    if (!pos || !idx) return 0;
    let bad = 0;
    for (let k = 0; k < idx.count; k += 3) {
      const a = idx.getX(k);
      const b = idx.getX(k + 1);
      const c = idx.getX(k + 2);
      const cross = (pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a)) - (pos.getZ(b) - pos.getZ(a)) * (pos.getX(c) - pos.getX(a));
      // the quads are wound (x right, z down) so that every triangle has a negative xz cross product
      if (!(cross < -1e-6)) bad++;
    }
    return bad;
  }

  /** border alpha of a tile's vertex (u, v ∈ 0..2); for tests */
  alphaAt(tile: number, u: number, v: number): number {
    const i = this.of.get(tile);
    return i === undefined ? -1 : this.base[i * 9 + v * 3 + u];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Wall geometry
// ---------------------------------------------------------------------------

/** shade the side faces of a geometry from `bottom` (at y=0) to 1 (at y=h) via vertex colours */
function verticalShade(geo: THREE.BufferGeometry, h: number, bottom: number, top = 1): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.max(0, Math.min(1, pos.getY(i) / h));
    const up = nrm ? nrm.getY(i) : 0;
    const v = up > 0.7 ? top : bottom + (top - bottom) * Math.pow(k, 0.8);
    c.set([v, v, v], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

/**
 * Box wall of height h: sides tile their texture per tile of height and darken towards the floor
 * (contact shading), the top (material group 2/3) stays bright.
 */
export function boxWallGeometry(h: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, h, 1);
  g.translate(0, h / 2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const index = g.index!.array as ArrayLike<number>;
  const side = new Set<number>();
  for (const gr of g.groups) {
    if (gr.materialIndex === 2 || gr.materialIndex === 3) continue;
    for (let k = gr.start; k < gr.start + gr.count; k++) side.add(index[k]);
  }
  for (const vi of side) uv.setY(vi, uv.getY(vi) * h);
  uv.needsUpdate = true;
  verticalShade(g, h, 0.62);
  return g;
}

/**
 * Soft blob for organic layouts: a noisy capsule whose bottom is buried in the floor and whose top is
 * a rounded cap. Neighbouring blobs overlap into one lumpy membrane.
 */
export function blobWallGeometry(h: number): THREE.BufferGeometry {
  const r = 0.6;
  const len = Math.max(0.01, h + 0.15 - r);
  const g = new THREE.CapsuleGeometry(r, len, 6, 14, 2);
  // capsule is centred: shift so its top is at h
  g.translate(0, h - (len / 2 + r), 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = Math.sin(x * 5.1 + y * 3.7) * 0.5 + Math.sin(z * 4.3 - y * 5.9 + 1.3) * 0.5 + Math.sin((x + z) * 7.7) * 0.25;
    const k = 1 + n * 0.07;
    pos.setXYZ(i, x * k, y + n * 0.03, z * k);
  }
  g.computeVertexNormals();
  verticalShade(g, h, 0.7, 1.0);
  // brighten the rounded crown so it reads like a cap from above
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const up = Math.max(0, nrm.getY(i));
    const v = col.getX(i) * (1 + up * 0.28);
    col.setXYZ(i, v, v, v);
  }
  return g;
}

/**
 * A thin bar along the north top edge of a wall tile (rotate by k·90° for the other edges). Drawn on
 * the edges that face open ground so walls get a crisp, lighter outline.
 */
export function edgeBarGeometry(h: number, thick = 0.05): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1.02, thick, thick * 1.3);
  g.translate(0, h - thick / 2 + 0.006, -0.5 + (thick * 1.3) / 2 - 0.004);
  return g;
}

/**
 * Inverted rocky cone hanging under a floor tile at a void edge: square top (covers the tile), a
 * jagged middle and a narrow tip. Height 1 (scale per instance), top at y = 0.
 */
export function undersideGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.72, 0.12, 1, 4, 3, false);
  g.rotateY(Math.PI / 4);
  g.translate(0, -0.5, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > -0.01 || y < -0.99) continue;
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const j = 0.85 + hash2(Math.round(x * 100), Math.round(z * 100), Math.round(y * 100)) * 0.3;
    pos.setXYZ(i, x * j, y, z * j);
  }
  const ng = g.toNonIndexed();
  g.dispose();
  ng.computeVertexNormals();
  // darker towards the tip
  const p2 = ng.getAttribute('position') as THREE.BufferAttribute;
  const c = new Float32Array(p2.count * 3);
  for (let i = 0; i < p2.count; i++) {
    const v = 0.5 + 0.5 * (1 + p2.getY(i));
    c.set([v, v, v], i * 3);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return ng;
}

/**
 * Straight earth/structure skirt under floor tiles at a void edge for layouts that are not floating
 * islands: the map reads as a solid diorama block instead of a paper-thin sheet. Height 1, top at 0.
 */
export function skirtGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  g.translate(0, -0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = 0.35 + 0.65 * (1 + p.getY(i));
    c.set([v, v, v], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Layouts whose void edges are drawn as floating platforms (rocky undersides, soft glow). */
export function floatsOverVoid(generator: string): boolean {
  return generator === 'islands' || generator === 'geometric' || generator === 'organic';
}

// ---------------------------------------------------------------------------
// Ripple normal map (liquids)
// ---------------------------------------------------------------------------

let rippleTex: THREE.Texture | null = null;

/** Tileable normal map of overlapping small waves; null outside the browser. */
export function rippleNormalTexture(): THREE.Texture | null {
  if (rippleTex) return rippleTex;
  if (!hasCanvas()) return null;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(S, S);
  const waves = [
    [1, 2, 0.0, 1],
    [3, -1, 1.3, 0.6],
    [-2, 3, 2.1, 0.5],
    [5, 4, 0.7, 0.3],
    [-6, 1, 4.2, 0.25],
  ];
  const height = (x: number, y: number) => {
    let s = 0;
    for (const [kx, ky, ph, a] of waves) s += a * Math.sin(((kx * x + ky * y) / S) * Math.PI * 2 + ph);
    return s;
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      const nx = -dx * 2.2;
      const ny = -dy * 2.2;
      const l = Math.hypot(nx, ny, 1);
      const k = (y * S + x) * 4;
      img.data[k] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  rippleTex = t;
  return t;
}

export function disposeSurfaceTextures(): void {
  rippleTex?.dispose();
  rippleTex = null;
}
