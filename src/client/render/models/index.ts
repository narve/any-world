/**
 * Model builder: turns an AI-written `ModelSpec` into a three.js object.
 *
 *   buildModel(spec, opts?) → THREE.Group   root at the feet (y=0), facing +z (towards a camera in the south)
 *   animateModel(root, timeSec, motion?)     idle + per-part procedural animation; call every frame
 *   modelHeight(root)                        world-space height of a built model (for hp bars/labels)
 *
 * Structure: root (position/rotation owned by the caller) → `body` group (spec.scale, idle animation)
 * → archetype meshes + spec.parts. Animation state lives in plain `userData` so `root.clone()` works.
 */
import * as THREE from 'three';
import type { ModelSpec, Part } from '../../../schema/world';
import { prim, DEG, type Shape } from './geom';
import { buildHumanoid } from './humanoid';
import {
  buildQuadruped,
  buildFlier,
  buildBlob,
  buildSerpent,
  buildPlant,
  buildVehicle,
  buildRobot,
  buildPropDefault,
  buildFreeformDefault,
  type Palette3,
} from './archetypes';
import { shade } from '../color';

/** Loose input type: accepts parsed specs and raw JSON (defaults may be missing). */
export type ModelSpecIn = Partial<ModelSpec> & { archetype: ModelSpec['archetype'] };

export interface BuildModelOptions {
  /** add a THREE.PointLight for spec.light (default true). The game renderer pools lights instead. */
  lights?: boolean;
  /** idle animation phase offset (radians); defaults to a deterministic per-build sequence */
  phase?: number;
  /** override every colour (unknown items tinted by their run appearance), mixed at this strength */
  tint?: { color: string; strength: number };
}

const SHAPES: Record<Part['shape'], Shape> = {
  box: 'box',
  sphere: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
  capsule: 'capsule',
  torus: 'torus',
  pyramid: 'pyramid',
  plane: 'plane',
};

export function buildModel(spec: ModelSpecIn, opts: BuildModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'model';
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const pal: Palette3 = {
    primary: spec.colors?.primary ?? '#9a948a',
    secondary: spec.colors?.secondary ?? shade(spec.colors?.primary ?? '#9a948a', 1.3),
    accent: spec.colors?.accent ?? '#f2c14e',
  };
  const parts = spec.parts ?? [];

  let base: THREE.Object3D | null = null;
  switch (spec.archetype) {
    case 'humanoid':
      base = buildHumanoid(
        spec.humanoid ?? { skin: '#d9a77c', top: pal.primary, bottom: pal.secondary, accent: pal.accent },
      );
      break;
    case 'quadruped':
      base = buildQuadruped(pal);
      break;
    case 'flier':
      base = buildFlier(pal);
      break;
    case 'blob':
      base = buildBlob(pal);
      break;
    case 'serpent':
      base = buildSerpent(pal);
      break;
    case 'vehicle':
      base = buildVehicle(pal);
      break;
    case 'robot':
      base = buildRobot(pal);
      break;
    case 'plant':
      base = buildPlant(pal);
      break;
    case 'prop':
      if (parts.length === 0) base = buildPropDefault(pal);
      break;
    case 'freeform':
      if (parts.length === 0) base = buildFreeformDefault(pal);
      break;
  }
  if (base) body.add(base);

  for (const part of parts) body.add(buildPart(part));

  const scale = clampNum(spec.scale ?? 1, 0.2, 3, 1);
  body.scale.setScalar(scale);

  if (opts.tint) applyTint(body, opts.tint.color, opts.tint.strength);

  root.userData.idle = spec.idle ?? 'bob';
  root.userData.archetype = spec.archetype;
  root.userData.phase = opts.phase ?? nextPhase();
  if (spec.light) {
    root.userData.light = { color: spec.light.color, intensity: spec.light.intensity, radius: spec.light.radius };
    if (opts.lights !== false && spec.light.intensity > 0) {
      const l = new THREE.PointLight(spec.light.color, spec.light.intensity * 3, Math.max(0.5, spec.light.radius * 1.5), 1.6);
      l.position.set(0, 0.6 * scale, 0);
      l.name = 'model-light';
      root.add(l);
    }
  }
  return root;
}

export function buildPart(part: Part | (Partial<Part> & Pick<Part, 'shape' | 'size' | 'color'>)): THREE.Object3D {
  const shape = SHAPES[part.shape] ?? 'box';
  const size = (part.size ?? [0.2, 0.2, 0.2]).map((v) => clampNum(v, 0.003, 6, 0.2)) as [number, number, number];
  if (shape === 'plane') {
    // planes are thin slabs; the smallest axis becomes paper-thin
    const minIdx = size.indexOf(Math.min(...size));
    size[minIdx] = Math.max(0.006, Math.min(size[minIdx], 0.02));
  }
  const pos = (part.pos ?? [0, 0, 0]).map((v) => clampNum(v, -6, 6, 0)) as [number, number, number];
  const rot = (part.rot ?? [0, 0, 0]).map((v) => clampNum(v, -720, 720, 0) * DEG) as [number, number, number];
  const mesh = prim(shape, size, [0, 0, 0], part.color, {
    material: part.material ?? 'matte',
    emissive: part.emissive,
    emissiveIntensity: part.emissive ? 1.1 : undefined,
    castShadow: part.material !== 'glow' && part.material !== 'glass',
  });
  // wrap in a pivot so group animations (wing flap, spin…) rotate the part around its own position
  const pivot = new THREE.Group();
  pivot.position.set(pos[0], pos[1], pos[2]);
  pivot.rotation.set(rot[0], rot[1], rot[2]);
  pivot.add(mesh);
  const group = part.group?.toLowerCase();
  if (group) {
    pivot.name = `part:${group}`;
    pivot.userData.anim = { kind: 'group', group, base: [rot[0], rot[1], rot[2]], side: pos[0] < 0 ? -1 : 1 };
  }
  return pivot;
}

let phaseSeq = 0;
function nextPhase(): number {
  phaseSeq = (phaseSeq + 1) % 1000;
  return (phaseSeq * 2.399963) % (Math.PI * 2); // golden-angle spread
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
}

function applyTint(obj: THREE.Object3D, color: string, strength: number): void {
  const tint = new THREE.Color(color);
  const done = new Map<THREE.Material, THREE.Material>();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    let t = done.get(src) as THREE.MeshStandardMaterial | undefined;
    if (!t) {
      t = src.clone();
      t.color.lerp(tint, strength);
      if (t.emissive && t.emissiveIntensity > 0) t.emissive.lerp(tint, strength);
      t.userData.cached = false;
      done.set(src, t);
    }
    m.material = t;
  });
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** Optional motion hints from the renderer (walking, attacking). */
export interface Motion {
  /** 0..1 while moving between tiles (drives leg/arm swing) */
  walk?: number;
  /** 0..1 attack swing progress */
  swing?: number;
}

interface AnimNode {
  obj: THREE.Object3D;
  kind: string;
  side: number;
  index: number;
  group?: string;
  base: [number, number, number];
  baseRot: THREE.Euler;
  basePos: THREE.Vector3;
}

const animCache = new WeakMap<THREE.Object3D, { body: THREE.Object3D | null; nodes: AnimNode[]; light: THREE.PointLight | null; lightBase: number }>();

function collect(root: THREE.Object3D) {
  let entry = animCache.get(root);
  if (entry) return entry;
  const nodes: AnimNode[] = [];
  let body: THREE.Object3D | null = null;
  let light: THREE.PointLight | null = null;
  root.traverse((o) => {
    if (o.name === 'body' && !body) body = o;
    if ((o as THREE.PointLight).isPointLight && o.name === 'model-light') light = o as THREE.PointLight;
    const a = o.userData.anim;
    if (a && typeof a.kind === 'string') {
      nodes.push({
        obj: o,
        kind: a.kind,
        side: a.side ?? 1,
        index: a.index ?? 0,
        group: a.group,
        base: a.base ?? [o.rotation.x, o.rotation.y, o.rotation.z],
        baseRot: o.rotation.clone(),
        basePos: o.position.clone(),
      });
    }
  });
  entry = { body, nodes, light, lightBase: light ? (light as THREE.PointLight).intensity : 0 };
  animCache.set(root, entry);
  return entry;
}

/** Animate a model built by buildModel. `t` in seconds. Cheap: no allocations per frame. */
export function animateModel(root: THREE.Object3D, t: number, motion: Motion = {}): void {
  const { body, nodes, light, lightBase } = collect(root);
  const ph = (root.userData.phase as number) ?? 0;
  const idle = root.userData.idle as string;
  const walk = motion.walk ?? 0;
  const walking = walk > 0 && walk < 1;
  if (body) {
    const s = body.scale.x; // uniform scale set by buildModel
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    switch (idle) {
      case 'bob':
        body.position.y = Math.abs(Math.sin(t * 2.2 + ph)) * 0.025 * s;
        break;
      case 'sway':
        body.rotation.z = Math.sin(t * 1.6 + ph) * 0.05;
        break;
      case 'pulse': {
        const k = 1 + Math.sin(t * 3 + ph) * 0.045;
        body.scale.set(s * k, s * (2 - k), s * k);
        body.userData.__pulse = true;
        break;
      }
      case 'spin':
        body.rotation.y = t * 1.4 + ph;
        break;
      case 'hover':
        body.position.y = (0.12 + Math.sin(t * 2 + ph) * 0.05) * s;
        break;
      case 'flicker':
        body.position.x = Math.sin(t * 37 + ph) * 0.006 * (Math.sin(t * 5.3 + ph) > 0.6 ? 1 : 0);
        break;
      default:
        break;
    }
    if (idle !== 'pulse' && body.userData.__pulse) {
      body.scale.setScalar(s);
      body.userData.__pulse = false;
    }
    if (walking) body.position.y += Math.sin(walk * Math.PI) * 0.04 * s;
  }
  if (light) {
    light.intensity = idle === 'flicker' ? lightBase * (0.65 + 0.35 * Math.abs(Math.sin(t * 13 + ph) * Math.sin(t * 7.1))) : lightBase;
  }
  for (const n of nodes) {
    const o = n.obj;
    switch (n.kind) {
      case 'arm': {
        const swing = walking ? Math.sin(walk * Math.PI * 2) * 0.5 * n.side : Math.sin(t * 1.3 + ph) * 0.04;
        o.rotation.x = n.baseRot.x + swing + (motion.swing && n.side < 0 ? -Math.sin(motion.swing * Math.PI) * 1.2 : 0);
        break;
      }
      case 'leg':
        o.rotation.x = n.baseRot.x + (walking ? Math.sin(walk * Math.PI * 2) * 0.5 * n.side : 0);
        break;
      case 'leg4':
        o.rotation.x = n.baseRot.x + (walking ? Math.sin(walk * Math.PI * 2) * 0.6 * n.side : 0);
        break;
      case 'head':
        o.rotation.y = n.baseRot.y + Math.sin(t * 0.7 + ph) * 0.12;
        o.rotation.x = n.baseRot.x + Math.sin(t * 1.1 + ph * 2) * 0.04;
        break;
      case 'tail':
        o.rotation.y = n.baseRot.y + Math.sin(t * 4 + ph) * 0.4;
        break;
      case 'wing':
        o.rotation.z = n.baseRot.z + n.side * Math.sin(t * 9 + ph) * 0.55;
        break;
      case 'flybob':
        o.position.y = n.basePos.y + Math.sin(t * 3 + ph) * 0.04;
        break;
      case 'squish': {
        const k = 1 + Math.sin(t * 2.6 + ph) * 0.06;
        o.scale.set(k, 2 - k, k);
        break;
      }
      case 'segment':
        o.position.x = n.basePos.x + Math.sin(t * 3 + n.index * 0.8 + ph) * 0.03;
        break;
      case 'foliage':
        o.rotation.z = Math.sin(t * 1.2 + ph) * 0.03;
        break;
      case 'wheel':
        o.rotation.x = walking ? walk * Math.PI * 4 : 0;
        break;
      case 'group':
        animateGroup(n, t, ph, walk);
        break;
    }
  }
}

function animateGroup(n: AnimNode, t: number, ph: number, walk: number): void {
  const o = n.obj;
  const g = n.group ?? '';
  if (g.includes('wing') || g.includes('fin')) {
    o.rotation.z = n.base[2] + n.side * Math.sin(t * 8 + ph) * 0.5;
  } else if (g.includes('spin') || g.includes('rotor') || g.includes('ring') || g.includes('orbit')) {
    o.rotation.y = n.base[1] + t * 2.2;
  } else if (g.includes('head')) {
    o.rotation.y = n.base[1] + Math.sin(t * 0.8 + ph) * 0.15;
  } else if (g.includes('tail') || g.includes('tentacle') || g.includes('arm')) {
    o.rotation.z = n.base[2] + Math.sin(t * 3 + ph + n.side) * 0.25;
  } else if (g.includes('leg') && walk > 0 && walk < 1) {
    o.rotation.x = n.base[0] + Math.sin(walk * Math.PI * 2) * 0.5 * n.side;
  } else if (g.includes('glow') || g.includes('pulse') || g.includes('core') || g.includes('eye')) {
    const k = 1 + Math.sin(t * 4 + ph) * 0.08;
    o.scale.setScalar(k);
  } else if (g.includes('float') || g.includes('hover') || g.includes('bob')) {
    o.position.y = n.basePos.y + Math.sin(t * 2 + ph) * 0.04;
  } else {
    // unknown group names get a gentle sway so they still feel alive
    o.rotation.z = n.base[2] + Math.sin(t * 1.5 + ph) * 0.06;
  }
}

/** Height of the model's bounding box (local, including body scale). */
export function modelHeight(root: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return 0.9;
  return Math.max(0.2, box.max.y);
}
