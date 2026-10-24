import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildModel, animateModel, modelHeight, type ModelSpecIn } from './index';
import { HumanoidParams, ModelSpec, Part } from '../../../schema/world';
import { parseWorld } from '../../../schema/refs';

function stats(obj: THREE.Object3D) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  let meshes = 0;
  let bad = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      meshes++;
      const e = m.matrixWorld.elements;
      if (e.some((v) => !Number.isFinite(v))) bad++;
    }
  });
  const size = box.getSize(new THREE.Vector3());
  return { box, size, meshes, bad };
}

const human = (over: Partial<ReturnType<typeof HumanoidParams.parse>> = {}) =>
  ModelSpec.parse({ archetype: 'humanoid', humanoid: { skin: '#d9a77c', top: '#3a5a8c', bottom: '#2a2a30', ...over } });

describe('buildModel', () => {
  it('builds every archetype with sane bounds, standing on the ground', () => {
    for (const archetype of ModelSpec.shape.archetype.options) {
      const spec: ModelSpecIn =
        archetype === 'humanoid' ? human() : ModelSpec.parse({ archetype, colors: { primary: '#884422', secondary: '#ddaa66', accent: '#22ccff' } });
      const m = buildModel(spec, { lights: false });
      const s = stats(m);
      expect(s.meshes, archetype).toBeGreaterThan(0);
      expect(s.bad, archetype).toBe(0);
      expect(s.size.y, archetype).toBeGreaterThan(0.15);
      expect(s.size.y, archetype).toBeLessThan(1.6);
      expect(Math.max(s.size.x, s.size.z), archetype).toBeLessThan(1.6);
      expect(s.box.min.y, archetype).toBeGreaterThan(-0.05);
    }
  });

  it('covers every humanoid option (headwear × outfit × holding × hair × build)', () => {
    const hp = HumanoidParams.shape;
    const headwear = hp.headwear.unwrap().options;
    const outfit = hp.outfit.unwrap().options;
    const holding = hp.holding.unwrap().options;
    const hair = hp.hairStyle.unwrap().options;
    const builds = hp.build.unwrap().options;
    const n = Math.max(headwear.length, outfit.length, holding.length, hair.length, builds.length);
    for (let i = 0; i < n * 2; i++) {
      const spec = human({
        headwear: headwear[i % headwear.length],
        outfit: outfit[(i * 3) % outfit.length],
        holding: holding[(i * 5) % holding.length],
        hairStyle: hair[i % hair.length],
        build: builds[i % builds.length],
        height: 0.5 + (i % 5) * 0.2,
      });
      const m = buildModel(spec, { lights: false });
      const s = stats(m);
      expect(s.bad).toBe(0);
      const h = spec.humanoid!.height;
      // a humanoid is roughly as tall as its height param (hats/staffs may add a bit)
      expect(s.size.y).toBeGreaterThan(h * 0.85);
      expect(s.size.y).toBeLessThan(h * 1.45);
    }
  });

  it('humanoid height drives model height', () => {
    const small = stats(buildModel(human({ height: 0.6 }))).size.y;
    const tall = stats(buildModel(human({ height: 1.2 }))).size.y;
    expect(tall / small).toBeGreaterThan(1.8);
  });

  it('appends every part shape and material, honouring pos, rot (degrees) and emissive', () => {
    const shapes = Part.shape.shape.options;
    const mats = Part.shape.material.unwrap().options;
    const parts = shapes.map((shape, i) =>
      Part.parse({ shape, size: [0.2, 0.3, 0.2], pos: [i * 0.3, 0.2, 0], rot: [0, 0, 90], color: '#ff0000', material: mats[i % mats.length], emissive: i === 0 ? '#00ff00' : undefined }),
    );
    const m = buildModel(ModelSpec.parse({ archetype: 'freeform', parts }), { lights: false });
    const s = stats(m);
    expect(s.meshes).toBe(shapes.length);
    // rotated 90° about z: the 0.3-tall box lies down, so x extent of first part ≈ 0.3
    const first = m.getObjectByName('body')!.children[0];
    expect(first.rotation.z).toBeCloseTo(Math.PI / 2);
    const mat = (first.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.emissive.getHex()).toBe(0x00ff00);
  });

  it('applies spec.scale and adds an optional light', () => {
    const a = stats(buildModel(ModelSpec.parse({ archetype: 'robot', colors: { primary: '#999999' }, scale: 2 }))).size.y;
    const b = stats(buildModel(ModelSpec.parse({ archetype: 'robot', colors: { primary: '#999999' }, scale: 1 }))).size.y;
    expect(a / b).toBeCloseTo(2, 1);
    const lit = buildModel(ModelSpec.parse({ archetype: 'prop', light: { color: '#ffaa00', intensity: 2, radius: 3 } }));
    expect(lit.getObjectByName('model-light')).toBeTruthy();
    const unlit = buildModel(ModelSpec.parse({ archetype: 'prop', light: { color: '#ffaa00', intensity: 2, radius: 3 } }), { lights: false });
    expect(unlit.getObjectByName('model-light')).toBeFalsy();
    expect(unlit.userData.light.radius).toBe(3);
  });

  it('accepts raw JSON specs with missing defaults', () => {
    const m = buildModel({ archetype: 'prop', parts: [{ shape: 'box', size: [0.2, 0.2, 0.2], color: '#123456' } as never] });
    expect(stats(m).meshes).toBe(1);
  });

  it('every idle animation runs without producing NaN and returns to rest-ish', () => {
    for (const idle of ModelSpec.shape.idle.unwrap().options) {
      const m = buildModel(ModelSpec.parse({ archetype: 'flier', colors: { primary: '#334455' }, idle, parts: [{ shape: 'box', size: [0.1, 0.1, 0.1], color: '#fff', group: 'wing' }] }));
      for (let t = 0; t < 3; t += 0.37) animateModel(m, t, { walk: (t % 1), swing: t % 1 });
      expect(stats(m).bad).toBe(0);
    }
  });

  it('builds every model in every fixture world', () => {
    const dir = join(__dirname, '../../../../content/worlds');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const res = parseWorld(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      expect(res.ok, f).toBe(true);
      if (!res.ok) continue;
      const w = res.world;
      const specs = [w.player.model, ...w.actors.map((a) => a.model), ...w.items.map((i) => i.model), ...w.terrains.flatMap((t) => (t.model ? [t.model] : [])), ...w.areas.flatMap((a) => (a.transitionModel ? [a.transitionModel] : []))];
      for (const spec of specs) {
        const m = buildModel(spec, { lights: false, tint: { color: '#ff00ff', strength: 0.5 } });
        const s = stats(m);
        expect(s.bad).toBe(0);
        expect(modelHeight(m)).toBeGreaterThan(0);
      }
    }
  });
});

describe('mergeModel', () => {
  it('merges a model into one geometry per material without losing triangles', async () => {
    const { mergeModel } = await import('./merge');
    const m = buildModel(ModelSpec.parse({ archetype: 'robot', colors: { primary: '#888888', secondary: '#444444', accent: '#00ffcc' } }), { lights: false });
    let tris = 0;
    const mats = new Set<THREE.Material>();
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mats.add(mesh.material as THREE.Material);
      const g = mesh.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    const parts = mergeModel(m);
    expect(parts.length).toBe(mats.size);
    const merged = parts.reduce((n, p) => n + p.geometry.getAttribute('position').count / 3, 0);
    expect(merged).toBe(tris);
    const box = new THREE.Box3();
    for (const p of parts) {
      p.geometry.computeBoundingBox();
      box.union(p.geometry.boundingBox!);
    }
    m.updateMatrixWorld(true);
    const ref = new THREE.Box3().setFromObject(m);
    expect(box.max.y).toBeCloseTo(ref.max.y, 3);
  });
});
