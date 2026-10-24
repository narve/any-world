/**
 * Material factory for the World Spec material hints (matte/metal/glass/glow/cloth/wood/stone/skin).
 * Materials are cached by (kind, colour, emissive) so thousands of parts share a handful of materials.
 */
import * as THREE from 'three';
import { col } from './color';

export type MaterialKind = 'matte' | 'metal' | 'glass' | 'glow' | 'cloth' | 'wood' | 'stone' | 'skin';

const cache = new Map<string, THREE.MeshStandardMaterial>();

export interface MaterialOpts {
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  map?: THREE.Texture | null;
  side?: THREE.Side;
}

export function getMaterial(kind: string | undefined, color: string, opts: MaterialOpts = {}): THREE.MeshStandardMaterial {
  const k = (kind ?? 'matte') as MaterialKind;
  const key = [k, color, opts.emissive ?? '', opts.emissiveIntensity ?? '', opts.opacity ?? '', opts.map?.uuid ?? '', opts.side ?? ''].join('|');
  const hit = cache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({ color: col(color) });
  switch (k) {
    case 'metal':
      m.metalness = 0.55;
      m.roughness = 0.38;
      break;
    case 'glass':
      m.metalness = 0.1;
      m.roughness = 0.08;
      m.transparent = true;
      m.opacity = 0.5;
      m.depthWrite = false;
      break;
    case 'glow':
      m.roughness = 0.5;
      m.emissive = col(color);
      m.emissiveIntensity = 1.6;
      break;
    case 'cloth':
      m.roughness = 1;
      break;
    case 'wood':
      m.roughness = 0.82;
      m.flatShading = true;
      break;
    case 'stone':
      m.roughness = 0.95;
      m.flatShading = true;
      break;
    case 'skin':
      m.roughness = 0.62;
      break;
    default:
      m.roughness = 0.85;
      m.flatShading = true;
  }
  if (opts.emissive) {
    m.emissive = col(opts.emissive);
    m.emissiveIntensity = opts.emissiveIntensity ?? 0.9;
  } else if (opts.emissiveIntensity !== undefined && k === 'glow') {
    m.emissiveIntensity = opts.emissiveIntensity;
  }
  if (opts.opacity !== undefined && opts.opacity < 1) {
    m.transparent = true;
    m.opacity = opts.opacity;
    m.depthWrite = false;
  }
  if (opts.map) m.map = opts.map;
  if (opts.side !== undefined) m.side = opts.side;
  m.userData.cached = true;
  cache.set(key, m);
  return m;
}

/** Disposes every cached material (call when tearing down the last renderer). */
export function clearMaterialCache(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  for (const m of dimCache.values()) m.dispose();
  dimCache.clear();
}

// ---------------------------------------------------------------------------
// "Remembered" variants: darker, cooler, desaturated copies used for fog of war.
// ---------------------------------------------------------------------------

const dimCache = new Map<string, THREE.Material>();
const REMEMBER_TINT = new THREE.Color(0.3, 0.32, 0.4);

export function dimMaterial(m: THREE.Material): THREE.Material {
  const hit = dimCache.get(m.uuid);
  if (hit) return hit;
  const d = m.clone();
  const std = d as THREE.MeshStandardMaterial;
  if (std.color) {
    const hsl = { h: 0, s: 0, l: 0 };
    std.color.getHSL(hsl);
    std.color.setHSL(hsl.h, hsl.s * 0.35, hsl.l);
    std.color.multiply(REMEMBER_TINT);
  }
  if (std.emissive) std.emissiveIntensity = (std.emissiveIntensity ?? 1) * 0.25;
  d.userData.dim = true;
  dimCache.set(m.uuid, d);
  return d;
}

const originalMats = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();

/** Swap every mesh under `obj` between its normal and its remembered (dim) material. */
export function setDimmed(obj: THREE.Object3D, dim: boolean): void {
  if (obj.userData.__dim === dim) return;
  obj.userData.__dim = dim;
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.noDim) return;
    if (!originalMats.has(mesh)) originalMats.set(mesh, mesh.material);
    const orig = originalMats.get(mesh)!;
    if (dim) mesh.material = Array.isArray(orig) ? orig.map(dimMaterial) : dimMaterial(orig);
    else mesh.material = orig;
  });
}
