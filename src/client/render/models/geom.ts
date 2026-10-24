/**
 * Shared, cached unit geometries for model parts. Every primitive fits a 1×1×1 box centred on the
 * origin, so a part of `size [x,y,z]` is just a mesh scaled by that size.
 */
import * as THREE from 'three';
import { getMaterial } from '../materials';

export type Shape = 'box' | 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'torus' | 'pyramid' | 'plane' | 'hemisphere' | 'ico' | 'frustum' | 'rbox' | 'tube';

const geoCache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    g.userData.shared = true;
    geoCache.set(key, g);
  }
  return g;
}

/** Unit geometry for a shape (fits a 1×1×1 box). */
export function unitGeometry(shape: Shape): THREE.BufferGeometry {
  switch (shape) {
    case 'box':
    case 'plane':
      return cached('box', () => new THREE.BoxGeometry(1, 1, 1));
    case 'rbox':
      return cached('rbox', () => roundedBox(1, 1, 1, 0.12));
    case 'sphere':
      return cached('sphere', () => new THREE.SphereGeometry(0.5, 14, 10));
    case 'hemisphere':
      return cached('hemi', () => new THREE.SphereGeometry(0.5, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.5));
    case 'ico':
      return cached('ico', () => new THREE.IcosahedronGeometry(0.5, 0));
    case 'cylinder':
      return cached('cyl', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 12));
    case 'tube':
      return cached('tube', () => new THREE.CylinderGeometry(0.5, 0.46, 1, 10, 1, true));
    case 'frustum':
      return cached('frustum', () => new THREE.CylinderGeometry(0.32, 0.5, 1, 12));
    case 'cone':
      return cached('cone', () => new THREE.ConeGeometry(0.5, 1, 12));
    case 'pyramid':
      return cached('pyr', () => {
        const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
        g.rotateY(Math.PI / 4);
        return g;
      });
    case 'capsule':
      return cached('capsule', () => {
        // radius 0.5, total height 1 → length 0 would be a sphere; use 0.25 radius and scale.
        const g = new THREE.CapsuleGeometry(0.25, 0.5, 4, 10);
        g.scale(2, 1, 2);
        return g;
      });
    case 'torus':
      return cached('torus', () => {
        // lying flat in XZ, outer diameter 1, tube thickness 0.2 (scale y to change thickness)
        const g = new THREE.TorusGeometry(0.4, 0.1, 8, 20);
        g.rotateX(Math.PI / 2);
        g.scale(1, 5, 1); // tube is 0.2 thick in y → normalise to 1 so size.y sets the thickness
        return g;
      });
  }
}

/** A capsule with real proportions (radius r, total height h), cached by dimensions. */
export function capsuleGeometry(r: number, h: number): THREE.BufferGeometry {
  const len = Math.max(0.001, h - 2 * r);
  return cached(`cap:${r.toFixed(3)}:${len.toFixed(3)}`, () => new THREE.CapsuleGeometry(r, len, 3, 10));
}

/** A partial torus arc in the XY plane. */
export function arcGeometry(radius: number, tube: number, arc: number): THREE.BufferGeometry {
  return cached(`arc:${radius}:${tube}:${arc}`, () => new THREE.TorusGeometry(radius, tube, 6, 16, arc));
}

/** Flat wing / fin shape (triangle-ish) in the XZ plane, thickness in y. */
export function wingGeometry(): THREE.BufferGeometry {
  return cached('wing', () => {
    const s = new THREE.Shape();
    s.moveTo(0, -0.15);
    s.lineTo(1, -0.35);
    s.lineTo(0.85, 0.05);
    s.lineTo(0.55, 0.2);
    s.lineTo(0, 0.25);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    g.translate(0, 0.02, 0);
    return g;
  });
}

function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  // Low-poly chamfered box: a box with bevelled vertical edges via ExtrudeGeometry.
  const s = new THREE.Shape();
  const hw = w / 2 - r;
  const hd = d / 2 - r;
  s.moveTo(-hw, -d / 2);
  s.lineTo(hw, -d / 2);
  s.lineTo(w / 2, -hd);
  s.lineTo(w / 2, hd);
  s.lineTo(hw, d / 2);
  s.lineTo(-hw, d / 2);
  s.lineTo(-w / 2, hd);
  s.lineTo(-w / 2, -hd);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h - 2 * r * 0.5, bevelEnabled: true, bevelSize: r * 0.5, bevelThickness: r * 0.5, bevelSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(0, -(bb.min.y + bb.max.y) / 2, 0);
  g.computeVertexNormals();
  return g;
}

export interface MeshOpts {
  material?: string;
  side?: THREE.Side;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  rot?: [number, number, number]; // radians
  name?: string;
  castShadow?: boolean;
}

/** Create a mesh of a unit shape scaled to `size`, at `pos`. */
export function prim(
  shape: Shape,
  size: [number, number, number],
  pos: [number, number, number],
  color: string,
  opts: MeshOpts = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    unitGeometry(shape),
    getMaterial(opts.material ?? 'matte', color, { emissive: opts.emissive, emissiveIntensity: opts.emissiveIntensity, opacity: opts.opacity, side: opts.side }),
  );
  const sx = Math.max(0.005, Math.abs(size[0]));
  const sy = Math.max(0.005, Math.abs(size[1]));
  const sz = Math.max(0.005, Math.abs(size[2]));
  mesh.scale.set(sx, sy, sz);
  mesh.position.set(pos[0], pos[1], pos[2]);
  if (opts.rot) mesh.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
  if (opts.name) mesh.name = opts.name;
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Create a mesh from an arbitrary (cached) geometry. */
export function meshOf(geo: THREE.BufferGeometry, color: string, opts: MeshOpts = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(
    geo,
    getMaterial(opts.material ?? 'matte', color, { emissive: opts.emissive, emissiveIntensity: opts.emissiveIntensity, opacity: opts.opacity, side: opts.side }),
  );
  if (opts.rot) mesh.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
  if (opts.name) mesh.name = opts.name;
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = true;
  return mesh;
}

export const DEG = Math.PI / 180;
