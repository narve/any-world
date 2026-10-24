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
