/**
 * Non-humanoid archetype generators. All face +z with their feet/base at y=0 and are sized so that
 * a scale-1 model fits roughly one tile. Colours: primary (body), secondary (belly/limbs/detail),
 * accent (eyes/lights/trim).
 */
import * as THREE from 'three';
import { prim, meshOf, wingGeometry, DEG } from './geom';
import { shade, luminance } from '../color';

export interface Palette3 {
  primary: string;
  secondary: string;
  accent: string;
}

function eyes(g: THREE.Object3D, x: number, y: number, z: number, size: number, accent: string): void {
  // white sclera + dark pupil reads at small sizes; accent tint on very dark bodies
  for (const side of [-1, 1]) {
    g.add(prim('sphere', [size, size, size * 0.7], [side * x, y, z], '#f4f1ea', { material: 'matte', castShadow: false }));
    g.add(prim('sphere', [size * 0.55, size * 0.6, size * 0.4], [side * x, y, z + size * 0.3], accent && luminance(accent) < 0.35 ? accent : '#141218', { material: 'matte', castShadow: false }));
  }
}

export function buildQuadruped(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  const bodyY = 0.42;
  g.add(prim('rbox', [0.3, 0.26, 0.62], [0, bodyY, 0], c.primary, { material: 'cloth', name: 'body' }));
  g.add(prim('rbox', [0.24, 0.08, 0.5], [0, bodyY - 0.12, 0.01], c.secondary, { material: 'cloth' }));
  // shoulders hump
  g.add(prim('sphere', [0.3, 0.26, 0.26], [0, bodyY + 0.05, 0.18], c.primary, { material: 'cloth' }));
  // legs
  const legColor = shade(c.primary, 0.8);
  for (const [lx, lz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
    const leg = new THREE.Group();
    leg.position.set(lx * 0.1, bodyY - 0.06, lz * 0.21);
    leg.add(prim('capsule', [0.075, 0.36, 0.075], [0, -0.16, 0], legColor, { material: 'cloth' }));
    leg.add(prim('box', [0.08, 0.04, 0.1], [0, -0.335, 0.015], shade(c.secondary, 0.6), { material: 'matte' }));
    leg.userData.anim = { kind: 'leg4', side: lx * lz };
    g.add(leg);
  }
  // neck + head
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, bodyY + 0.14, 0.36);
  head.userData.anim = { kind: 'head' };
  head.add(prim('rbox', [0.2, 0.18, 0.22], [0, 0, 0], c.primary, { material: 'cloth' }));
  head.add(prim('rbox', [0.13, 0.1, 0.15], [0, -0.035, 0.13], c.secondary, { material: 'cloth' }));
  head.add(prim('sphere', [0.05, 0.04, 0.04], [0, -0.01, 0.21], '#1b1b1f', { material: 'matte', castShadow: false }));
  for (const side of [-1, 1]) head.add(prim('cone', [0.07, 0.11, 0.04], [side * 0.065, 0.12, -0.03], c.primary, { material: 'cloth', rot: [0, 0, -side * 15 * DEG] }));
  eyes(head, 0.055, 0.035, 0.105, 0.045, c.accent);
  g.add(prim('cylinder', [0.14, 0.18, 0.14], [0, bodyY + 0.07, 0.29], c.primary, { material: 'cloth', rot: [40 * DEG, 0, 0] }));
  g.add(head);
  // tail
  const tail = new THREE.Group();
  tail.position.set(0, bodyY + 0.06, -0.31);
  tail.userData.anim = { kind: 'tail' };
  tail.add(prim('capsule', [0.06, 0.26, 0.06], [0, 0.03, -0.1], c.secondary, { material: 'cloth', rot: [-55 * DEG, 0, 0] }));
  g.add(tail);
  return g;
}

export function buildFlier(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  const y = 0.55;
  const body = new THREE.Group();
  body.name = 'flier-body';
  body.position.y = y;
  body.add(prim('sphere', [0.26, 0.24, 0.36], [0, 0, 0], c.primary, { material: 'cloth' }));
  body.add(prim('sphere', [0.2, 0.16, 0.26], [0, -0.05, 0.02], c.secondary, { material: 'cloth' }));
  // head
  body.add(prim('sphere', [0.18, 0.17, 0.18], [0, 0.08, 0.18], c.primary, { material: 'cloth' }));
  body.add(prim('cone', [0.06, 0.12, 0.06], [0, 0.06, 0.31], c.accent, { material: 'matte', rot: [90 * DEG, 0, 0] }));
  eyes(body, 0.05, 0.11, 0.25, 0.04, c.secondary);
  // tail fan
  body.add(prim('box', [0.16, 0.02, 0.16], [0, 0.0, -0.22], shade(c.primary, 0.8), { material: 'cloth', rot: [15 * DEG, 0, 0] }));
  // wings: pivot groups that flap around z
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.1, 0.04, 0);
    const wing = meshOf(wingGeometry(), shade(c.primary, 0.9), { material: 'cloth', side: THREE.DoubleSide });
    wing.scale.set(0.42, 1, 0.55);
    if (side < 0) wing.scale.x *= -1;
    pivot.add(wing);
    const tip = meshOf(wingGeometry(), c.secondary, { material: 'cloth', side: THREE.DoubleSide });
    tip.scale.set(0.2 * side, 1.4, 0.3);
    tip.position.set(side * 0.24, 0.006, -0.03);
    pivot.add(tip);
    pivot.userData.anim = { kind: 'wing', side };
    body.add(pivot);
  }
  // dangling feet
  for (const side of [-1, 1]) body.add(prim('cylinder', [0.02, 0.12, 0.02], [side * 0.05, -0.16, 0.02], c.accent, { material: 'matte' }));
  g.add(body);
  // ground shadow blob is supplied by the renderer ring; flier hovers by default
  body.userData.anim = { kind: 'flybob' };
  return g;
}

export function buildBlob(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Group();
  core.name = 'blob';
  core.userData.anim = { kind: 'squish' };
  core.add(prim('sphere', [0.62, 0.48, 0.62], [0, 0.23, 0], c.primary, { material: 'glass', opacity: 0.82 }));
  core.add(prim('sphere', [0.3, 0.24, 0.3], [0.04, 0.22, -0.02], c.secondary, { material: 'matte', emissive: c.secondary, emissiveIntensity: 0.25 }));
  core.add(prim('sphere', [0.5, 0.36, 0.5], [0, 0.32, 0], shade(c.primary, 1.2), { material: 'glass', opacity: 0.35 }));
  eyes(core, 0.08, 0.32, 0.27, 0.07, c.accent);
  // drips
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    core.add(prim('sphere', [0.1, 0.06, 0.1], [Math.sin(a) * 0.3, 0.03, Math.cos(a) * 0.3], c.primary, { material: 'glass', opacity: 0.8 }));
  }
  g.add(core);
  return g;
}

export function buildSerpent(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  const n = 8;
  // coiled S-curve on the ground, rising into the head at the front
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0 tail → 1 neck
    const r = 0.06 + t * 0.07;
    const seg = new THREE.Group();
    const x = Math.sin(t * Math.PI * 1.6) * 0.18;
    const z = -0.32 + t * 0.5;
    const y = r + Math.max(0, t - 0.75) * 0.9;
    seg.position.set(x, y, z);
    seg.userData.anim = { kind: 'segment', index: i, base: [x, y, z] };
    seg.add(prim('sphere', [r * 2.1, r * 2, r * 2.3], [0, 0, 0], i % 2 ? c.primary : c.secondary, { material: 'skin' }));
    g.add(seg);
  }
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 0.42, 0.25);
  head.userData.anim = { kind: 'head' };
  head.add(prim('rbox', [0.2, 0.12, 0.24], [0, 0, 0.03], c.primary, { material: 'skin' }));
  head.add(prim('rbox', [0.17, 0.05, 0.2], [0, -0.05, 0.04], c.secondary, { material: 'skin' }));
  eyes(head, 0.065, 0.045, 0.1, 0.045, c.accent);
  head.add(prim('box', [0.012, 0.006, 0.1], [0, -0.04, 0.19], '#d64545', { material: 'matte', castShadow: false }));
  g.add(head);
  return g;
}

export function buildPlant(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  const trunk = shade(c.primary, 0.55);
  g.add(prim('cylinder', [0.1, 0.4, 0.1], [0, 0.2, 0], trunk, { material: 'wood' }));
  const sway = new THREE.Group();
  sway.userData.anim = { kind: 'foliage' };
  const clusters: [number, number, number, number][] = [
    [0, 0.58, 0, 0.42],
    [-0.16, 0.46, 0.05, 0.3],
    [0.17, 0.48, -0.04, 0.3],
    [0.02, 0.78, -0.02, 0.26],
  ];
  clusters.forEach(([x, y, z, s], i) => {
    sway.add(prim('ico', [s, s * 0.9, s], [x, y, z], i % 2 ? c.secondary : c.primary, { material: 'matte', rot: [i, i * 2, 0] }));
  });
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7;
    sway.add(prim('sphere', [0.05, 0.05, 0.05], [Math.sin(a) * 0.2, 0.55 + (i % 2) * 0.18, Math.cos(a) * 0.2], c.accent, { material: 'matte', castShadow: false }));
  }
  g.add(sway);
  return g;
}

export function buildVehicle(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  g.add(prim('rbox', [0.5, 0.2, 0.86], [0, 0.24, 0], c.primary, { material: 'metal' }));
  g.add(prim('rbox', [0.42, 0.18, 0.4], [0, 0.42, -0.06], c.secondary, { material: 'metal' }));
  g.add(prim('box', [0.38, 0.12, 0.02], [0, 0.43, 0.145], '#9fd4ff', { material: 'glass' }));
  g.add(prim('box', [0.52, 0.06, 0.06], [0, 0.17, 0.44], shade(c.primary, 0.5), { material: 'metal' }));
  for (const side of [-1, 1]) {
    g.add(prim('cylinder', [0.07, 0.03, 0.07], [side * 0.17, 0.27, 0.43], c.accent, { material: 'glow', rot: [90 * DEG, 0, 0], castShadow: false }));
    for (const z of [-0.28, 0.28]) {
      const wheel = new THREE.Group();
      wheel.position.set(side * 0.26, 0.11, z);
      wheel.userData.anim = { kind: 'wheel' };
      wheel.add(prim('cylinder', [0.22, 0.1, 0.22], [0, 0, 0], '#26262b', { material: 'matte', rot: [0, 0, 90 * DEG] }));
      wheel.add(prim('cylinder', [0.1, 0.11, 0.1], [0, 0, 0], '#9aa0a8', { material: 'metal', rot: [0, 0, 90 * DEG] }));
      g.add(wheel);
    }
  }
  return g;
}

export function buildRobot(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  const joint = shade(c.secondary, 0.7);
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.08, 0.32, 0);
    leg.userData.anim = { kind: 'leg', side };
    leg.add(prim('box', [0.09, 0.28, 0.1], [0, -0.15, 0], c.secondary, { material: 'metal' }));
    leg.add(prim('box', [0.12, 0.05, 0.16], [0, -0.3, 0.02], joint, { material: 'metal' }));
    g.add(leg);
  }
  g.add(prim('rbox', [0.34, 0.3, 0.22], [0, 0.48, 0], c.primary, { material: 'metal', name: 'torso' }));
  g.add(prim('cylinder', [0.08, 0.04, 0.08], [0, 0.5, 0.11], c.accent, { material: 'glow', rot: [90 * DEG, 0, 0], castShadow: false }));
  g.add(prim('box', [0.24, 0.03, 0.01], [0, 0.4, 0.112], joint, { material: 'metal' }));
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.21, 0.6, 0);
    arm.userData.anim = { kind: 'arm', side };
    arm.add(prim('sphere', [0.09, 0.09, 0.09], [0, 0, 0], joint, { material: 'metal' }));
    arm.add(prim('box', [0.07, 0.24, 0.07], [0, -0.14, 0], c.secondary, { material: 'metal' }));
    arm.add(prim('box', [0.09, 0.06, 0.06], [0, -0.28, 0.01], joint, { material: 'metal' }));
    g.add(arm);
  }
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 0.73, 0);
  head.userData.anim = { kind: 'head' };
  head.add(prim('rbox', [0.24, 0.16, 0.2], [0, 0, 0], c.primary, { material: 'metal' }));
  head.add(prim('box', [0.19, 0.05, 0.02], [0, 0.01, 0.1], c.accent, { material: 'glow', castShadow: false }));
  head.add(prim('cylinder', [0.012, 0.1, 0.012], [0.07, 0.12, 0], '#b0b6bd', { material: 'metal' }));
  head.add(prim('sphere', [0.03, 0.03, 0.03], [0.07, 0.18, 0], c.accent, { material: 'glow', castShadow: false }));
  g.add(head);
  return g;
}

export function buildPropDefault(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  g.add(prim('rbox', [0.4, 0.36, 0.4], [0, 0.18, 0], c.primary, { material: 'wood' }));
  g.add(prim('box', [0.42, 0.05, 0.42], [0, 0.3, 0], c.secondary, { material: 'metal' }));
  g.add(prim('box', [0.42, 0.05, 0.42], [0, 0.07, 0], c.secondary, { material: 'metal' }));
  return g;
}

export function buildFreeformDefault(c: Palette3): THREE.Group {
  const g = new THREE.Group();
  g.add(prim('ico', [0.45, 0.45, 0.45], [0, 0.4, 0], c.primary, { material: 'matte' }));
  g.add(prim('torus', [0.6, 0.04, 0.6], [0, 0.4, 0], c.secondary, { material: 'metal', rot: [70 * DEG, 0, 0] }));
  return g;
}
