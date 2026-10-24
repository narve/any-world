/**
 * Parametric low-poly humanoid. Built at a reference height of 0.9 tile units (feet at y=0,
 * facing +z) and scaled to `height`. Arms hang from pivot groups named "arm_l"/"arm_r" so the
 * renderer can swing them; the held item sits in the right hand (viewer's left when facing camera).
 */
import * as THREE from 'three';
import { prim, meshOf, capsuleGeometry, arcGeometry, DEG } from './geom';
import { shade, mixHex } from '../color';

export interface HumanoidParamsIn {
  height?: number;
  build?: 'slim' | 'average' | 'broad' | 'round';
  skin: string;
  top: string;
  bottom: string;
  accent?: string;
  hair?: string;
  hairStyle?: 'none' | 'short' | 'long' | 'bun' | 'mohawk' | 'braids';
  headwear?: string;
  outfit?: string;
  holding?: string;
}

const REF_H = 0.9;
const BUILD_W: Record<string, number> = { slim: 0.84, average: 1, broad: 1.22, round: 1.12 };

export function buildHumanoid(p: HumanoidParamsIn): THREE.Group {
  const g = new THREE.Group();
  g.name = 'humanoid';
  const build = p.build ?? 'average';
  const bw = BUILD_W[build] ?? 1;
  const outfit = p.outfit ?? 'plain';
  const accent = p.accent ?? shade(p.top, 0.6);
  const hair = p.hair ?? '#3b2a20';
  const suitBulk = outfit === 'spacesuit' ? 1.18 : outfit === 'armour' ? 1.08 : 1;
  const W = bw * suitBulk;

  // --- key heights (reference 0.9) ---
  const hipY = 0.4;
  const shoulderY = 0.62;
  const headY = 0.745;
  const headR = 0.108;
  const torsoW = 0.25 * W;
  const torsoD = 0.15 * (build === 'round' ? 1.25 : W);
  const legR = 0.05 * Math.min(1.25, bw) * (outfit === 'spacesuit' ? 1.25 : 1);
  const legX = 0.062 * W;
  const shoeColor = outfit === 'spacesuit' ? shade(p.bottom, 0.8) : shade(p.bottom, 0.45);

  // --- legs (hidden under long robes) ---
  const legsHidden = outfit === 'robe';
  for (const side of [-1, 1]) {
    if (!legsHidden) {
      const leg = meshOf(capsuleGeometry(legR, hipY - 0.02), p.bottom, { material: outfit === 'armour' ? 'metal' : 'cloth', name: 'leg' });
      leg.position.set(side * legX, hipY / 2 + 0.03, 0);
      leg.userData.anim = { kind: 'leg', side };
      g.add(leg);
    }
    const shoe = prim('rbox', [legR * 2.3, 0.06, legR * 3.2], [side * legX, 0.03, 0.02], shoeColor, { material: 'matte' });
    g.add(shoe);
  }

  // --- torso ---
  const torsoMat = outfit === 'armour' ? 'metal' : outfit === 'spacesuit' ? 'matte' : 'cloth';
  const torsoH = shoulderY - hipY + 0.04;
  const torso = prim('rbox', [torsoW, torsoH, torsoD], [0, hipY + torsoH / 2 - 0.02, 0], p.top, { material: torsoMat, name: 'torso' });
  g.add(torso);
  if (build === 'round') {
    g.add(prim('sphere', [torsoW * 1.02, torsoH * 0.85, torsoD * 1.25], [0, hipY + 0.07, 0.015], p.top, { material: torsoMat }));
  }
  // hips / waist band in bottom colour
  if (!legsHidden && outfit !== 'dress') {
    g.add(prim('rbox', [torsoW * 0.96, 0.07, torsoD * 0.95], [0, hipY - 0.005, 0], p.bottom, { material: 'cloth' }));
  }
  // neck
  g.add(prim('cylinder', [0.06, 0.06, 0.06], [0, shoulderY + 0.03, 0], p.skin, { material: 'skin' }));

  addOutfit(g, outfit, p, { W, hipY, shoulderY, torsoW, torsoD, torsoH, accent });

  // --- arms (pivot at shoulder) ---
  const armLen = 0.27;
  const armR = 0.036 * Math.min(1.3, bw) * (outfit === 'spacesuit' ? 1.3 : 1);
  const sleeve = outfit === 'rags' ? p.skin : outfit === 'armour' ? shade(p.top, 0.85) : p.top;
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'arm_r' : 'arm_l';
    pivot.position.set(side * (torsoW / 2 + armR * 0.9), shoulderY - 0.02, 0);
    pivot.rotation.z = side * 7 * DEG;
    const arm = meshOf(capsuleGeometry(armR, armLen), sleeve, { material: outfit === 'armour' ? 'metal' : 'cloth' });
    arm.position.y = -armLen / 2;
    pivot.add(arm);
    const handColor = outfit === 'spacesuit' ? p.bottom : p.skin;
    const hand = prim('sphere', [armR * 2.3, armR * 2.3, armR * 2.3], [0, -armLen - 0.005, 0], handColor, { material: 'skin', name: 'hand' });
    pivot.add(hand);
    pivot.userData.anim = { kind: 'arm', side };
    g.add(pivot);
    arms.push(pivot);
  }
  const rightArm = arms[0]; // side -1
  const leftArm = arms[1];

  // --- head ---
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, headY, 0);
  head.add(prim('sphere', [headR * 2, headR * 2.05, headR * 1.95], [0, 0, 0], p.skin, { material: 'skin' }));
  // eyes + brows give a readable facing direction
  for (const side of [-1, 1]) {
    head.add(prim('sphere', [0.026, 0.032, 0.02], [side * 0.038, 0.012, headR * 0.92], '#1d1a22', { material: 'matte', castShadow: false }));
  }
  // nose hint
  head.add(prim('sphere', [0.024, 0.024, 0.024], [0, -0.012, headR * 0.98], shade(p.skin, 0.85), { material: 'skin', castShadow: false }));
  addHair(head, p.hairStyle ?? 'short', hair, headR, p.headwear ?? 'none');
  addHeadwear(head, p.headwear ?? 'none', p, headR, accent);
  g.add(head);

  // --- held item ---
  addHeld(rightArm, leftArm, p.holding ?? 'none', p, accent, armLen);

  const h = p.height ?? REF_H;
  g.scale.setScalar(h / REF_H);
  return g;
}

interface Dims {
  W: number;
  hipY: number;
  shoulderY: number;
  torsoW: number;
  torsoD: number;
  torsoH: number;
  accent: string;
}

function addOutfit(g: THREE.Group, outfit: string, p: HumanoidParamsIn, d: Dims): void {
  const { hipY, shoulderY, torsoW, torsoD, accent } = d;
  const front = torsoD / 2;
  switch (outfit) {
    case 'coat': {
      // long coat tails over the legs, lapels and buttons
      const tail = shade(p.top, 0.88);
      for (const side of [-1, 1]) {
        g.add(prim('box', [torsoW * 0.5, 0.26, torsoD * 1.08], [side * torsoW * 0.26, hipY - 0.1, -0.005], tail, { material: 'cloth', rot: [0, 0, side * 4 * DEG] }));
        g.add(prim('box', [0.035, 0.16, 0.012], [side * 0.045, shoulderY - 0.09, front + 0.004], shade(p.top, 0.7), { material: 'cloth', rot: [0, 0, -side * 18 * DEG] }));
      }
      g.add(prim('box', [torsoW * 1.04, 0.035, torsoD * 1.06], [0, hipY + 0.02, 0], shade(accent, 0.8), { material: 'matte' }));
      g.add(prim('box', [torsoW * 0.9, 0.045, torsoD * 1.15], [0, shoulderY + 0.005, -0.01], shade(p.top, 0.8), { material: 'cloth' }));
      break;
    }
    case 'robe': {
      // floor-length skirt hiding the legs
      g.add(prim('frustum', [torsoW * 1.6, hipY + 0.02, torsoD * 2.1], [0, (hipY + 0.02) / 2, 0], p.top, { material: 'cloth' }));
      g.add(prim('box', [torsoW * 1.04, 0.04, torsoD * 1.08], [0, hipY + 0.03, 0], accent, { material: 'cloth' }));
      g.add(prim('box', [0.04, 0.2, 0.012], [0, shoulderY - 0.1, front + 0.004], accent, { material: 'cloth' }));
      break;
    }
    case 'armour': {
      g.add(prim('rbox', [torsoW * 1.06, 0.15, torsoD * 1.12], [0, shoulderY - 0.08, 0.004], shade(p.top, 1.15), { material: 'metal' }));
      for (const side of [-1, 1]) {
        g.add(prim('sphere', [0.1, 0.07, 0.1], [side * (torsoW / 2 + 0.02), shoulderY + 0.005, 0], shade(p.top, 1.1), { material: 'metal' }));
        g.add(prim('box', [torsoW * 0.42, 0.1, 0.02], [side * torsoW * 0.24, hipY - 0.08, front - 0.005], shade(p.top, 0.9), { material: 'metal' }));
      }
      g.add(prim('box', [torsoW * 1.05, 0.04, torsoD * 1.1], [0, hipY + 0.02, 0], accent, { material: 'matte' }));
      break;
    }
    case 'suit': {
      g.add(prim('box', [0.07, 0.13, 0.01], [0, shoulderY - 0.07, front + 0.003], '#f2efe8', { material: 'cloth' }));
      g.add(prim('box', [0.022, 0.12, 0.012], [0, shoulderY - 0.08, front + 0.008], accent, { material: 'cloth' }));
      for (const side of [-1, 1]) {
        g.add(prim('box', [0.03, 0.15, 0.012], [side * 0.045, shoulderY - 0.08, front + 0.006], shade(p.top, 0.75), { material: 'cloth', rot: [0, 0, -side * 16 * DEG] }));
      }
      g.add(prim('box', [torsoW * 1.02, 0.08, torsoD * 1.05], [0, hipY - 0.01, 0], p.top, { material: 'cloth' }));
      break;
    }
    case 'dress': {
      g.add(prim('frustum', [torsoW * 1.7, 0.26, torsoD * 2.0], [0, hipY - 0.08, 0], p.top, { material: 'cloth' }));
      g.add(prim('box', [torsoW * 1.04, 0.035, torsoD * 1.08], [0, hipY + 0.06, 0], accent, { material: 'cloth' }));
      break;
    }
    case 'spacesuit': {
      g.add(prim('rbox', [torsoW * 0.85, 0.24, 0.1], [0, shoulderY - 0.1, -torsoD / 2 - 0.045], shade(p.top, 0.75), { material: 'metal' }));
      g.add(prim('box', [0.09, 0.06, 0.012], [0, shoulderY - 0.1, front + 0.004], '#1b2430', { material: 'matte' }));
      g.add(prim('box', [0.025, 0.02, 0.01], [-0.02, shoulderY - 0.1, front + 0.012], accent, { material: 'glow' }));
      g.add(prim('box', [0.025, 0.02, 0.01], [0.022, shoulderY - 0.1, front + 0.012], '#ff6b6b', { material: 'glow' }));
      g.add(prim('torus', [0.2 * d.W, 0.04, 0.17 * d.W], [0, shoulderY + 0.02, 0], shade(p.top, 0.85), { material: 'metal' }));
      g.add(prim('box', [torsoW * 1.04, 0.04, torsoD * 1.08], [0, hipY + 0.02, 0], accent, { material: 'matte' }));
      break;
    }
    case 'uniform': {
      g.add(prim('box', [torsoW * 1.05, 0.035, torsoD * 1.08], [0, hipY + 0.02, 0], accent, { material: 'matte' }));
      for (let i = 0; i < 3; i++) g.add(prim('sphere', [0.016, 0.016, 0.01], [0, shoulderY - 0.05 - i * 0.055, front + 0.003], '#e7d27a', { material: 'metal', castShadow: false }));
      for (const side of [-1, 1]) {
        g.add(prim('box', [0.07, 0.018, 0.08], [side * (torsoW / 2 - 0.01), shoulderY + 0.012, 0], accent, { material: 'cloth' }));
      }
      g.add(prim('box', [0.05, 0.035, 0.008], [torsoW * 0.25, shoulderY - 0.06, front + 0.003], accent, { material: 'matte' }));
      break;
    }
    case 'rags': {
      const ragColor = shade(p.top, 0.8);
      for (let i = 0; i < 5; i++) {
        const x = (i - 2) * torsoW * 0.22;
        const len = 0.06 + ((i * 37) % 5) * 0.012;
        g.add(prim('box', [torsoW * 0.2, len, torsoD * 1.04], [x, hipY - len / 2 + 0.01, 0], ragColor, { material: 'cloth', rot: [0, 0, (i % 2 ? 1 : -1) * 6 * DEG] }));
      }
      g.add(prim('box', [0.06, 0.05, 0.01], [-0.05, shoulderY - 0.1, front + 0.003], shade(p.top, 0.6), { material: 'cloth', rot: [0, 0, 12 * DEG] }));
      g.add(prim('box', [0.05, 0.04, 0.01], [0.06, hipY + 0.06, front + 0.003], mixHex(p.top, p.bottom, 0.5), { material: 'cloth', rot: [0, 0, -8 * DEG] }));
      g.add(prim('box', [torsoW * 1.04, 0.025, torsoD * 1.06], [0, hipY + 0.03, 0], '#6b5137', { material: 'matte' }));
      break;
    }
    default: {
      // plain: a collar line and a hint of a belt
      g.add(prim('box', [torsoW * 1.02, 0.025, torsoD * 1.04], [0, hipY + 0.025, 0], shade(p.bottom, 0.7), { material: 'matte' }));
    }
  }
}

function addHair(head: THREE.Group, style: string, hair: string, r: number, headwear: string): void {
  if (style === 'none') return;
  const covered = headwear === 'helmet' || headwear === 'horned_helmet' || headwear === 'hood';
  const mat = { material: 'cloth' as const };
  if (!covered) {
    head.add(prim('hemisphere', [r * 2.14, r * 2.0, r * 2.12], [0, 0.012, -0.008], hair, { ...mat, rot: [-12 * DEG, 0, 0] }));
  }
  switch (style) {
    case 'long':
      head.add(prim('rbox', [r * 2.0, r * 2.3, r * 0.8], [0, -r * 0.55, -r * 0.62], hair, mat));
      for (const side of [-1, 1]) head.add(prim('box', [r * 0.35, r * 1.6, r * 1.0], [side * r * 0.86, -r * 0.35, -r * 0.18], hair, mat));
      break;
    case 'bun':
      head.add(prim('sphere', [r * 0.95, r * 0.95, r * 0.95], [0, r * 0.95, -r * 0.55], hair, mat));
      break;
    case 'mohawk':
      head.add(prim('box', [r * 0.3, r * 0.75, r * 2.0], [0, r * 1.05, -r * 0.1], hair, mat));
      break;
    case 'braids':
      for (const side of [-1, 1]) {
        head.add(prim('capsule', [r * 0.38, r * 2.0, r * 0.38], [side * r * 0.9, -r * 0.9, -r * 0.35], hair, mat));
        head.add(prim('sphere', [r * 0.3, r * 0.3, r * 0.3], [side * r * 0.9, -r * 1.95, -r * 0.35], shade(hair, 0.6), mat));
      }
      break;
    case 'short':
    default:
      break;
  }
}

function addHeadwear(head: THREE.Group, hw: string, p: HumanoidParamsIn, r: number, accent: string): void {
  // accents are usually bright trim colours; hats read better as a muted version of them
  const hatColor = p.accent ? mixHex(shade(p.accent, 0.75), '#2a2420', 0.4) : shade(p.top, 0.55);
  const band = shade(hatColor, 0.45);
  switch (hw) {
    case 'cowboy_hat': {
      head.add(prim('cylinder', [r * 3.2, 0.016, r * 2.9], [0, r * 0.62, 0], hatColor, { material: 'cloth' }));
      // upturned brim edges
      for (const side of [-1, 1]) head.add(prim('box', [r * 0.55, 0.016, r * 2.0], [side * r * 1.42, r * 0.72, 0], hatColor, { material: 'cloth', rot: [0, 0, side * 28 * DEG] }));
      head.add(prim('frustum', [r * 1.75, r * 0.95, r * 1.65], [0, r * 1.1, 0], hatColor, { material: 'cloth' }));
      head.add(prim('box', [r * 0.22, r * 0.22, r * 1.1], [0, r * 1.55, 0], shade(hatColor, 0.85), { material: 'cloth' })); // crease
      head.add(prim('cylinder', [r * 1.78, r * 0.2, r * 1.68], [0, r * 0.74, 0], band, { material: 'matte' }));
      break;
    }
    case 'cap': {
      head.add(prim('hemisphere', [r * 2.18, r * 1.9, r * 2.18], [0, r * 0.1, 0], hatColor, { material: 'cloth' }));
      head.add(prim('box', [r * 1.5, 0.015, r * 1.2], [0, r * 0.25, r * 1.2], shade(hatColor, 0.8), { material: 'cloth', rot: [-8 * DEG, 0, 0] }));
      head.add(prim('sphere', [0.02, 0.02, 0.02], [0, r * 1.05, 0], accent, { material: 'cloth', castShadow: false }));
      break;
    }
    case 'helmet':
    case 'horned_helmet': {
      const metal = p.accent && hw === 'helmet' ? p.accent : '#9aa2ab';
      head.add(prim('hemisphere', [r * 2.3, r * 2.2, r * 2.3], [0, r * 0.05, 0], metal, { material: 'metal' }));
      head.add(prim('torus', [r * 2.35, 0.025, r * 2.35], [0, r * 0.1, 0], shade(metal, 0.7), { material: 'metal' }));
      head.add(prim('box', [r * 0.22, r * 1.0, r * 0.3], [0, -r * 0.1, r * 1.05], shade(metal, 0.85), { material: 'metal' }));
      if (hw === 'horned_helmet') {
        for (const side of [-1, 1]) {
          const horn = prim('cone', [r * 0.45, r * 1.6, r * 0.45], [side * r * 1.35, r * 0.9, 0], '#efe4c8', { material: 'matte', rot: [0, 0, -side * 40 * DEG] });
          head.add(horn);
        }
      }
      break;
    }
    case 'hood': {
      const hood = p.top;
      head.add(prim('hemisphere', [r * 2.45, r * 2.4, r * 2.4], [0, r * 0.05, -r * 0.18], hood, { material: 'cloth', rot: [-25 * DEG, 0, 0] }));
      head.add(prim('rbox', [r * 2.3, r * 1.5, r * 1.3], [0, -r * 0.35, -r * 0.6], hood, { material: 'cloth' }));
      head.add(prim('torus', [r * 2.25, r * 0.4, r * 2.1], [0, r * 0.1, r * 0.18], shade(hood, 0.75), { material: 'cloth', rot: [70 * DEG, 0, 0] }));
      break;
    }
    case 'crown': {
      const gold = p.accent ?? '#e8c25a';
      head.add(prim('tube', [r * 1.85, r * 0.55, r * 1.85], [0, r * 0.85, 0], gold, { material: 'metal', side: THREE.DoubleSide }));
      head.add(prim('cylinder', [r * 1.9, r * 0.3, r * 1.9], [0, r * 0.65, 0], gold, { material: 'metal' }));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        head.add(prim('cone', [r * 0.32, r * 0.55, r * 0.32], [Math.sin(a) * r * 0.85, r * 1.3, Math.cos(a) * r * 0.85], gold, { material: 'metal' }));
      }
      head.add(prim('sphere', [r * 0.3, r * 0.3, r * 0.2], [0, r * 0.75, r * 0.95], '#d7263d', { material: 'glass', emissive: '#d7263d', emissiveIntensity: 0.6 }));
      break;
    }
    case 'top_hat': {
      const silk = p.accent ? mixHex(shade(p.accent, 0.5), '#18161c', 0.6) : '#1d1b22';
      head.add(prim('cylinder', [r * 2.7, 0.018, r * 2.6], [0, r * 0.62, 0], silk, { material: 'cloth' }));
      head.add(prim('cylinder', [r * 1.6, r * 1.8, r * 1.6], [0, r * 1.5, 0], silk, { material: 'cloth' }));
      head.add(prim('cylinder', [r * 1.63, r * 0.3, r * 1.63], [0, r * 0.8, 0], accent, { material: 'cloth' }));
      break;
    }
    case 'fedora': {
      head.add(prim('cylinder', [r * 3.1, 0.016, r * 3.0], [0, r * 0.58, 0.004], hatColor, { material: 'cloth', rot: [-6 * DEG, 0, 0] }));
      head.add(prim('frustum', [r * 1.9, r * 0.95, r * 1.9], [0, r * 1.05, 0], hatColor, { material: 'cloth' }));
      head.add(prim('box', [r * 0.2, r * 0.2, r * 1.4], [0, r * 1.52, 0], shade(hatColor, 0.85), { material: 'cloth' }));
      head.add(prim('cylinder', [r * 1.95, r * 0.24, r * 1.95], [0, r * 0.72, 0], band, { material: 'matte' }));
      break;
    }
    case 'headphones': {
      const c = p.accent ?? '#2b2d42';
      const arc = meshOf(arcGeometry(r * 1.12, r * 0.12, Math.PI), c, { material: 'matte' });
      arc.position.y = r * 0.05;
      head.add(arc);
      for (const side of [-1, 1]) head.add(prim('cylinder', [r * 0.75, r * 0.35, r * 0.75], [side * r * 1.08, 0, 0], c, { material: 'matte', rot: [0, 0, 90 * DEG] }));
      break;
    }
    case 'halo': {
      head.add(prim('torus', [r * 2.0, 0.025, r * 2.0], [0, r * 1.75, 0], '#fff2a8', { material: 'glow', castShadow: false }));
      break;
    }
    case 'antenna': {
      const c = p.accent ?? '#9be7ff';
      head.add(prim('cylinder', [0.012, r * 1.4, 0.012], [r * 0.35, r * 1.5, 0], '#b8c0c8', { material: 'metal' }));
      head.add(prim('sphere', [0.04, 0.04, 0.04], [r * 0.35, r * 2.25, 0], c, { material: 'glow', castShadow: false }));
      break;
    }
    case 'bandana': {
      const c = p.accent ?? '#c0392b';
      head.add(prim('cylinder', [r * 2.1, r * 0.42, r * 2.06], [0, r * 0.32, 0], c, { material: 'cloth' }));
      head.add(prim('sphere', [r * 0.4, r * 0.4, r * 0.4], [0, r * 0.3, -r * 1.05], c, { material: 'cloth' }));
      for (const side of [-1, 1]) head.add(prim('box', [r * 0.3, r * 0.9, 0.012], [side * r * 0.25, -r * 0.15, -r * 1.12], c, { material: 'cloth', rot: [0, 0, side * 18 * DEG] }));
      break;
    }
    default:
      break;
  }
}

function addHeld(rightArm: THREE.Group, leftArm: THREE.Group, holding: string, p: HumanoidParamsIn, accent: string, armLen: number): void {
  if (holding === 'none') return;
  const hand = new THREE.Group();
  hand.name = 'held';
  hand.position.set(0, -armLen - 0.01, 0.02);
  const metal = '#c9ced6';
  const wood = '#7a5230';
  const dark = '#2a2a30';
  switch (holding) {
    case 'sword':
      hand.add(prim('box', [0.025, 0.07, 0.025], [0, 0, 0], '#4a3423', { material: 'wood' }));
      hand.add(prim('box', [0.1, 0.02, 0.03], [0, 0.04, 0], accent, { material: 'metal' }));
      hand.add(prim('box', [0.035, 0.34, 0.012], [0, 0.22, 0], metal, { material: 'metal' }));
      hand.rotation.x = 70 * DEG;
      break;
    case 'gun':
      hand.add(prim('box', [0.03, 0.07, 0.04], [0, -0.01, 0], '#5a3a26', { material: 'wood', rot: [-15 * DEG, 0, 0] }));
      hand.add(prim('box', [0.035, 0.04, 0.06], [0, 0.03, 0.025], '#4a4f57', { material: 'metal' }));
      hand.add(prim('cylinder', [0.022, 0.12, 0.022], [0, 0.04, 0.1], '#6b717a', { material: 'metal', rot: [90 * DEG, 0, 0] }));
      hand.rotation.x = 15 * DEG;
      break;
    case 'rifle':
      hand.add(prim('box', [0.035, 0.05, 0.22], [0, 0, -0.05], '#6b4423', { material: 'wood' }));
      hand.add(prim('cylinder', [0.022, 0.38, 0.022], [0, 0.02, 0.22], '#50565e', { material: 'metal', rot: [90 * DEG, 0, 0] }));
      hand.add(prim('box', [0.03, 0.04, 0.06], [0, 0.035, 0.05], '#3d4148', { material: 'metal' }));
      hand.rotation.x = -35 * DEG;
      hand.position.z = 0.04;
      break;
    case 'staff':
      hand.add(prim('cylinder', [0.026, 0.95, 0.026], [0, 0.18, 0], wood, { material: 'wood' }));
      hand.add(prim('ico', [0.08, 0.08, 0.08], [0, 0.68, 0], accent, { material: 'glow', castShadow: false }));
      break;
    case 'book':
      hand.add(prim('box', [0.13, 0.16, 0.04], [0, 0.05, 0.03], accent, { material: 'cloth' }));
      hand.add(prim('box', [0.12, 0.15, 0.035], [0.006, 0.05, 0.031], '#f4ecd8', { material: 'matte' }));
      hand.rotation.x = -20 * DEG;
      break;
    case 'lantern':
      hand.add(prim('box', [0.09, 0.012, 0.09], [0, -0.03, 0], dark, { material: 'metal' }));
      hand.add(prim('cylinder', [0.065, 0.1, 0.065], [0, -0.09, 0], '#ffd27a', { material: 'glow', castShadow: false }));
      hand.add(prim('box', [0.09, 0.012, 0.09], [0, -0.15, 0], dark, { material: 'metal' }));
      hand.add(prim('torus', [0.06, 0.008, 0.06], [0, 0.0, 0], dark, { material: 'metal', rot: [90 * DEG, 0, 0] }));
      break;
    case 'phone':
      hand.add(prim('box', [0.06, 0.11, 0.012], [0, 0.04, 0.02], '#1c1c22', { material: 'matte' }));
      hand.add(prim('box', [0.05, 0.095, 0.004], [0, 0.04, 0.027], '#8fd3ff', { material: 'glow', castShadow: false }));
      hand.rotation.x = -40 * DEG;
      break;
    case 'axe':
      hand.add(prim('cylinder', [0.024, 0.5, 0.024], [0, 0.15, 0], wood, { material: 'wood' }));
      hand.add(prim('box', [0.14, 0.11, 0.018], [0.06, 0.36, 0], metal, { material: 'metal' }));
      hand.rotation.x = 50 * DEG;
      break;
    case 'shield': {
      const s = new THREE.Group();
      s.position.set(0.02, -armLen * 0.6, 0.06);
      s.add(prim('cylinder', [0.24, 0.025, 0.24], [0, 0, 0], p.accent ?? shade(p.top, 0.8), { material: 'wood', rot: [90 * DEG, 0, 0] }));
      s.add(prim('torus', [0.24, 0.02, 0.24], [0, 0, 0.005], '#9aa2ab', { material: 'metal', rot: [90 * DEG, 0, 0] }));
      s.add(prim('sphere', [0.05, 0.05, 0.03], [0, 0, 0.02], '#c9ced6', { material: 'metal' }));
      leftArm.add(s);
      return;
    }
    case 'tool':
      hand.add(prim('box', [0.025, 0.2, 0.02], [0, 0.06, 0], '#8d939b', { material: 'metal' }));
      hand.add(prim('torus', [0.06, 0.02, 0.06], [0, 0.17, 0], '#8d939b', { material: 'metal', rot: [90 * DEG, 0, 0] }));
      hand.add(prim('box', [0.03, 0.07, 0.03], [0, -0.01, 0], accent, { material: 'matte' }));
      hand.rotation.x = 40 * DEG;
      break;
    case 'wand':
      hand.add(prim('cylinder', [0.014, 0.22, 0.014], [0, 0.08, 0], '#3b2a1e', { material: 'wood' }));
      hand.add(prim('sphere', [0.035, 0.035, 0.035], [0, 0.2, 0], accent, { material: 'glow', castShadow: false }));
      hand.rotation.x = 55 * DEG;
      break;
    case 'bottle':
      hand.add(prim('cylinder', [0.05, 0.1, 0.05], [0, 0.02, 0.02], accent, { material: 'glass' }));
      hand.add(prim('cylinder', [0.02, 0.05, 0.02], [0, 0.09, 0.02], accent, { material: 'glass' }));
      hand.add(prim('cylinder', [0.022, 0.015, 0.022], [0, 0.12, 0.02], '#8b5a2b', { material: 'wood' }));
      break;
    default:
      return;
  }
  rightArm.add(hand);
  // raise the weapon arm slightly so held things read clearly
  rightArm.rotation.x = -18 * DEG;
}
