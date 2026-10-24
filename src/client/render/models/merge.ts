/**
 * Flatten a built model into one geometry per material (static: idle/part animation is dropped).
 * Used to instance terrain models, so a field of 200 lockers costs a handful of draw calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface MergedPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export function mergeModel(root: THREE.Object3D): MergedPart[] {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let g = mesh.geometry.clone();
    m.multiplyMatrices(inv, mesh.matrixWorld);
    g.applyMatrix4(m);
    if (g.index) g = g.toNonIndexed();
    // normalise attribute sets so every geometry can merge
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.clearGroups();
    // a negative-determinant transform flips winding: fix by swapping two vertices per triangle
    if (m.determinant() < 0) flipWinding(g);
    const list = groups.get(mesh.material) ?? [];
    list.push(g);
    groups.set(mesh.material, list);
  });
  const out: MergedPart[] = [];
  for (const [material, list] of groups) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (merged) out.push({ geometry: merged, material });
  }
  return out;
}

function flipWinding(g: THREE.BufferGeometry): void {
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const n = a.itemSize;
    const arr = a.array as Float32Array;
    for (let i = 0; i + 2 < a.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = arr[(i + 1) * n + k];
        arr[(i + 1) * n + k] = arr[(i + 2) * n + k];
        arr[(i + 2) * n + k] = t;
      }
    }
    a.needsUpdate = true;
  }
}

/** Default rigid nodes of a built model: the root, its `body` (idle animation) and every animated part. */
export function isRigidNode(root: THREE.Object3D, o: THREE.Object3D): boolean {
  return o === root || o.name === 'body' || !!(o.userData.anim && typeof o.userData.anim.kind === 'string');
}

/**
 * Cut the draw calls of an animated model without changing how it looks or moves: every mesh is
 * baked into its nearest *rigid* ancestor (the root, `body`, or a node with `userData.anim`) and the
 * meshes of one rigid node are merged per material (and per shadow / render-order / outline flags).
 * Animated nodes keep their transforms, so animateModel works unchanged on the result.
 *
 * A mesh is left alone when it is itself a rigid node or has a descendant that is not a mergeable
 * mesh (lights, animated parts…). Returns the number of meshes before minus after.
 */
export interface CompactOptions {
  /** which nodes keep their own transform (default: isRigidNode) */
  isRigid?: (o: THREE.Object3D) => boolean;
  /**
   * Materials that differ only in colour can share one draw call with per-vertex colours: return a
   * class key for such a material (same key = mergeable), or null to merge by material identity.
   */
  colorClass?: (m: THREE.Material) => string | null;
  /**
   * The vertex-coloured material used for a merged colour class (given the class's first material).
   * Merged geometry carries `color` (linear RGB), `aRough` and `aMetal` (the source materials'
   * roughness / metalness, when they have them) and flat-shaded sources get baked flat normals, so
   * the material should read those attributes and not use flatShading.
   */
  vertexColorMaterial?: (m: THREE.Material) => THREE.Material;
}

export function compactModel(root: THREE.Object3D, options: CompactOptions = {}): number {
  const isRigid = options.isRigid ?? ((o: THREE.Object3D) => isRigidNode(root, o));
  const colorClass = options.vertexColorMaterial ? options.colorClass : undefined;
  root.updateMatrixWorld(true);
  const plain = (o: THREE.Object3D): boolean => {
    const m = o as THREE.Mesh;
    return !!m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && !Array.isArray(m.material) && !isRigid(o);
  };
  // a mesh can be merged when its whole subtree is plain meshes (outline hulls are children of meshes)
  const memo = new Map<THREE.Object3D, boolean>();
  const mergeable = (o: THREE.Object3D): boolean => {
    let r = memo.get(o);
    if (r === undefined) {
      r = plain(o) && o.children.every(mergeable);
      memo.set(o, r);
    }
    return r;
  };
  const rigidOf = (o: THREE.Object3D): THREE.Object3D => {
    let p = o.parent;
    while (p && p !== root && !isRigid(p)) p = p.parent;
    return p ?? root;
  };
  const buckets = new Map<THREE.Object3D, Map<string, THREE.Mesh[]>>();
  let before = 0;
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    before++;
    if (!mergeable(o)) return;
    const m = o as THREE.Mesh;
    const rigid = rigidOf(m);
    const mat = m.material as THREE.Material;
    const cls = colorClass?.(mat) ?? null;
    const key = [cls !== null ? `class:${cls}` : mat.uuid, m.castShadow ? 1 : 0, m.receiveShadow ? 1 : 0, m.renderOrder, m.visible ? 1 : 0, m.userData.outline ? 1 : 0, m.userData.noDim ? 1 : 0, m.frustumCulled ? 1 : 0].join('|');
    let byKey = buckets.get(rigid);
    if (!byKey) buckets.set(rigid, (byKey = new Map()));
    const list = byKey.get(key) ?? [];
    list.push(m);
    byKey.set(key, list);
  });
  const rel = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const removed: THREE.Mesh[] = [];
  let after = before;
  for (const [rigid, byKey] of buckets) {
    inv.copy(rigid.matrixWorld).invert();
    for (const list of byKey.values()) {
      const geos: THREE.BufferGeometry[] = [];
      const mats = new Set(list.map((m) => m.material as THREE.Material));
      const recolor = mats.size > 1;
      for (const m of list) {
        let g = m.geometry.clone();
        rel.multiplyMatrices(inv, m.matrixWorld);
        g.applyMatrix4(rel);
        if (g.index) g = g.toNonIndexed();
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
        g.morphAttributes = {};
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        g.clearGroups();
        if (rel.determinant() < 0) flipWinding(g);
        if (recolor) {
          const src = m.material as THREE.MeshStandardMaterial;
          if (src.flatShading) g.computeVertexNormals(); // non-indexed: face normals = the flat look
          const c = src.color ?? new THREE.Color(1, 1, 1);
          const n = g.getAttribute('position').count;
          const arr = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            arr[i * 3] = c.r;
            arr[i * 3 + 1] = c.g;
            arr[i * 3 + 2] = c.b;
          }
          g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
          g.setAttribute('aRough', new THREE.Float32BufferAttribute(new Float32Array(n).fill(src.roughness ?? 1), 1));
          g.setAttribute('aMetal', new THREE.Float32BufferAttribute(new Float32Array(n).fill(src.metalness ?? 0), 1));
        }
        geos.push(g);
      }
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const first = list[0];
      const mesh = new THREE.Mesh(merged, recolor ? options.vertexColorMaterial!(first.material as THREE.Material) : first.material);
      mesh.name = first.userData.outline ? 'merged-outline' : 'merged';
      mesh.castShadow = first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.renderOrder = first.renderOrder;
      mesh.visible = first.visible;
      mesh.frustumCulled = first.frustumCulled;
      mesh.userData = { ...first.userData, merged: list.length };
      rigid.add(mesh);
      removed.push(...list);
      after -= list.length - 1;
    }
  }
  for (const m of removed) m.parent?.remove(m);
  return before - after;
}
