/**
 * Event VFX: projectiles, bursts, beams, clouds, sparkles, slashes, rings, floating text.
 * Everything is scheduled on the shared Animator and cleans itself up when done.
 */
import * as THREE from 'three';
import { Animator, ease } from './tween';
import { col } from './color';
import { glowTexture, textTexture } from './textures';

type V3 = THREE.Vector3;

let sphereGeo: THREE.SphereGeometry | null = null;
let ringGeo: THREE.RingGeometry | null = null;
let beamGeo: THREE.CylinderGeometry | null = null;
let slashGeo: THREE.TorusGeometry | null = null;

export const VFX_KINDS = ['none', 'bolt', 'burst', 'beam', 'cloud', 'sparkle', 'slash', 'ring'] as const;

export class VfxLayer {
  readonly group = new THREE.Group();
  private anim: Animator;
  /** height (world y) for floating text above an actor */
  constructor(anim: Animator) {
    this.anim = anim;
    this.group.name = 'vfx';
  }

  private basic(color: string, opacity = 1, additive = true): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color: col(color),
      transparent: true,
      opacity,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
  }

  private glow(color: string, size: number, opacity = 0.9): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: col(color), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(size);
    return s;
  }

  private cleanup(obj: THREE.Object3D): void {
    this.group.remove(obj);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const x of mats) x.dispose(); // shared textures/geometries are left alone
      }
    });
  }

  /** A glowing projectile from → to. Returns its flight time (ms). */
  bolt(from: V3, to: V3, color: string, delay = 0, blocking = true): number {
    sphereGeo ??= new THREE.SphereGeometry(0.5, 10, 8);
    const g = new THREE.Group();
    const core = new THREE.Mesh(sphereGeo, this.basic('#ffffff', 1));
    core.scale.setScalar(0.09);
    g.add(core, this.glow(color, 0.65));
    const trail = this.glow(color, 0.4, 0.5);
    g.add(trail);
    g.visible = false;
    this.group.add(g);
    const dist = from.distanceTo(to);
    const dur = Math.min(260, 70 + dist * 28);
    const tmp = new THREE.Vector3();
    this.anim.add({
      delay,
      duration: dur,
      blocking,
      start: () => (g.visible = true),
      update: (k) => {
        tmp.lerpVectors(from, to, k);
        tmp.y += Math.sin(k * Math.PI) * Math.min(0.6, dist * 0.06);
        g.position.copy(tmp);
        trail.position.set(0, 0, 0).sub(tmp.clone().sub(from).normalize().multiplyScalar(0.15));
      },
      done: () => {
        this.cleanup(g);
        this.burst(to, 0.35, color, 0, false);
      },
    });
    return dur;
  }

  burst(at: V3, radius: number, color: string, delay = 0, blocking = false): number {
    sphereGeo ??= new THREE.SphereGeometry(0.5, 10, 8);
    const r = Math.max(0.35, radius);
    const g = new THREE.Group();
    g.position.copy(at);
    const mat = this.basic(color, 0.6);
    const shell = new THREE.Mesh(sphereGeo, mat);
    const flash = this.glow(color, r * 3);
    g.add(shell, flash);
    g.visible = false;
    this.group.add(g);
    const dur = 300;
    this.anim.add({
      delay,
      duration: dur,
      blocking,
      ease: ease.outCubic,
      start: () => (g.visible = true),
      update: (k) => {
        shell.scale.setScalar(0.2 + k * r * 2);
        mat.opacity = 0.6 * (1 - k);
        (flash.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - k);
      },
      done: () => this.cleanup(g),
    });
    return dur;
  }

  beam(from: V3, to: V3, color: string, delay = 0, blocking = true): number {
    beamGeo ??= new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true);
    const g = new THREE.Group();
    const len = Math.max(0.01, from.distanceTo(to));
    const mid = from.clone().add(to).multiplyScalar(0.5);
    g.position.copy(mid);
    g.lookAt(to);
    const inner = new THREE.Mesh(beamGeo, this.basic('#ffffff', 0.9));
    const outer = new THREE.Mesh(beamGeo, this.basic(color, 0.55));
    inner.rotation.x = outer.rotation.x = Math.PI / 2;
    inner.scale.set(0.05, len, 0.05);
    outer.scale.set(0.16, len, 0.16);
    g.add(inner, outer);
    g.visible = false;
    this.group.add(g);
    const dur = 260;
    this.anim.add({
      delay,
      duration: dur,
      blocking,
      start: () => (g.visible = true),
      update: (k) => {
        const w = Math.sin(k * Math.PI);
        inner.scale.set(0.05 * w + 0.01, len, 0.05 * w + 0.01);
        outer.scale.set(0.18 * w + 0.01, len, 0.18 * w + 0.01);
      },
      done: () => this.cleanup(g),
    });
    this.burst(to, 0.3, color, delay + dur * 0.4, false);
    return dur;
  }

  cloud(at: V3, radius: number, color: string, delay = 0): number {
    const r = Math.max(0.6, radius);
    const g = new THREE.Group();
    g.position.copy(at);
    const puffs: { s: THREE.Sprite; dir: THREE.Vector3 }[] = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const s = this.glow(color, 0.8, 0.0);
      (s.material as THREE.SpriteMaterial).blending = THREE.NormalBlending;
      puffs.push({ s, dir: new THREE.Vector3(Math.cos(a), 0.15 + (i % 3) * 0.12, Math.sin(a)) });
      g.add(s);
    }
    this.group.add(g);
    const dur = 900;
    this.anim.add({
      delay,
      duration: dur,
      blocking: false,
      update: (k) => {
        for (const p of puffs) {
          p.s.position.copy(p.dir).multiplyScalar(r * ease.outCubic(k));
          p.s.position.y = 0.3 + p.dir.y * r + k * 0.3;
          p.s.scale.setScalar(0.6 + k * r * 1.4);
          (p.s.material as THREE.SpriteMaterial).opacity = 0.7 * Math.sin(Math.min(1, k * 1.3) * Math.PI);
        }
      },
      done: () => this.cleanup(g),
    });
    return 250;
  }

  sparkle(at: V3, radius: number, color: string, delay = 0): number {
    const r = Math.max(0.4, radius);
    const g = new THREE.Group();
    g.position.copy(at);
    const bits: { s: THREE.Sprite; p: THREE.Vector3; ph: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const a = i * 2.39996;
      const d = Math.sqrt((i + 0.5) / 14) * r;
      const s = this.glow(i % 3 === 0 ? '#ffffff' : color, 0.22, 0);
      bits.push({ s, p: new THREE.Vector3(Math.cos(a) * d, 0.15 + (i % 5) * 0.16, Math.sin(a) * d), ph: i * 0.7 });
      g.add(s);
    }
    this.group.add(g);
    const dur = 700;
    this.anim.add({
      delay,
      duration: dur,
      blocking: false,
      update: (k) => {
        for (const b of bits) {
          b.s.position.copy(b.p);
          b.s.position.y += k * 0.4;
          const tw = Math.max(0, Math.sin(k * Math.PI * 3 + b.ph));
          (b.s.material as THREE.SpriteMaterial).opacity = tw * (1 - k * 0.6);
          b.s.scale.setScalar(0.12 + tw * 0.18);
        }
      },
      done: () => this.cleanup(g),
    });
    return 200;
  }

  slash(at: V3, from: V3 | null, color: string, delay = 0): number {
    slashGeo ??= new THREE.TorusGeometry(0.38, 0.035, 4, 20, Math.PI * 0.9);
    const g = new THREE.Group();
    g.position.copy(at);
    g.position.y = 0.5;
    if (from) g.rotation.y = Math.atan2(at.x - from.x, at.z - from.z);
    const mat = this.basic(color, 1);
    const arc = new THREE.Mesh(slashGeo, mat);
    arc.rotation.set(0.5, 0, 0);
    g.add(arc);
    g.visible = false;
    this.group.add(g);
    const dur = 200;
    this.anim.add({
      delay,
      duration: dur,
      blocking: false,
      start: () => (g.visible = true),
      update: (k) => {
        arc.rotation.z = -1.6 + k * 2.2;
        mat.opacity = 1 - k * k;
        arc.scale.setScalar(0.8 + k * 0.4);
      },
      done: () => this.cleanup(g),
    });
    return dur;
  }

  ring(at: V3, radius: number, color: string, delay = 0, opacity = 0.85): number {
    ringGeo ??= new THREE.RingGeometry(0.85, 1, 48);
    const r = Math.max(0.5, radius + 0.5);
    const mat = this.basic(color, opacity);
    const m = new THREE.Mesh(ringGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.copy(at);
    m.position.y = 0.06;
    m.visible = false;
    this.group.add(m);
    const dur = 450;
    this.anim.add({
      delay,
      duration: dur,
      blocking: false,
      ease: ease.outCubic,
      start: () => (m.visible = true),
      update: (k) => {
        m.scale.setScalar(0.1 + k * r);
        mat.opacity = opacity * (1 - k);
      },
      done: () => this.cleanup(m),
    });
    return 150;
  }

  /** Dispatch on Action.vfx kind. Returns how long later events should wait (ms). */
  effect(kind: string, from: V3, to: V3, color: string, radius: number, delay = 0): number {
    switch (kind) {
      case 'none':
        return 0;
      case 'bolt':
        return from.distanceToSquared(to) < 0.01 ? this.burst(to, radius || 0.4, color, delay, false) * 0.5 : this.bolt(from, to, color, delay);
      case 'beam':
        return from.distanceToSquared(to) < 0.01 ? this.ring(to, radius, color, delay) : this.beam(from, to, color, delay);
      case 'cloud':
        return this.cloud(to, radius, color, delay);
      case 'sparkle':
        return this.sparkle(to, radius, color, delay);
      case 'slash':
        return this.slash(to, from, color, delay);
      case 'ring':
        return this.ring(to, radius, color, delay);
      case 'burst':
      default:
        this.burst(to, radius || 0.4, color, delay, false);
        return 150;
    }
  }

  /**
   * Floating text (damage numbers, misses, status names). With `follow`, the text stays over that
   * object (an actor's root) while it plays: `at` only gives the height, and x/z track the object
   * every frame, so a label never lingers on a tile the actor has already walked away from. It is
   * also hidden while the followed object is hidden.
   */
  text(at: V3, text: string, color: string, delay = 0, opts: { size?: number; rise?: number; duration?: number; follow?: THREE.Object3D } = {}): THREE.Sprite | null {
    const tt = textTexture(text, color, { size: 56 });
    if (!tt) return null;
    const mat = new THREE.SpriteMaterial({ map: tt.tex, transparent: true, depthTest: false, depthWrite: false });
    const s = new THREE.Sprite(mat);
    const h = (opts.size ?? 1) * 0.36;
    s.scale.set(h * tt.aspect, h, 1);
    s.renderOrder = 1000;
    s.position.copy(at);
    s.visible = false;
    const jitter = ((text.length * 37) % 10) / 40 - 0.12;
    s.position.x += jitter;
    this.group.add(s);
    const rise = opts.rise ?? 0.7;
    const y0 = at.y;
    const follow = opts.follow;
    const track = () => {
      if (!follow) return;
      s.position.x = follow.position.x + jitter;
      s.position.z = follow.position.z;
    };
    track();
    this.anim.add({
      delay,
      duration: opts.duration ?? 950,
      blocking: false,
      start: () => (s.visible = true),
      update: (k) => {
        track();
        if (follow) s.visible = follow.visible;
        s.position.y = y0 + ease.outCubic(k) * rise;
        const pop = k < 0.15 ? 0.7 + (k / 0.15) * 0.45 : 1.15 - Math.min(0.15, (k - 0.15) * 0.5);
        s.scale.set(h * tt.aspect * pop, h * pop, 1);
        mat.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      },
      done: () => {
        this.group.remove(s);
        tt.tex.dispose();
        mat.dispose();
      },
    });
    return s;
  }

  clear(): void {
    for (const c of [...this.group.children]) this.cleanup(c);
  }
}
