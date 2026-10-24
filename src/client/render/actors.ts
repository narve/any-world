/**
 * Actor views: one model per actor instance with a faction ring under it and a billboard hp bar.
 * Positions/animation are driven by the Renderer; this layer owns construction and per-frame idle.
 */
import * as THREE from 'three';
import type { WorldSpec, ModelSpec } from '../../schema/world';
import type { ActorInstance, Faction, Pos } from '../../engine/types';
import { buildModel, animateModel, modelHeight, type Motion } from './models';
import { col } from './color';

export const FACTION_COLORS: Record<Faction | 'ally', string> = {
  player: '#7fe3ff',
  hostile: '#ff5a4a',
  neutral: '#c2c2c2',
  friendly: '#5fe08a',
  ally: '#5fe08a',
};

const DEFAULT_MODEL: ModelSpec = {
  archetype: 'blob',
  colors: { primary: '#9a9aa6', secondary: '#c8c8d0', accent: '#222222' },
  parts: [],
  scale: 0.8,
  idle: 'pulse',
};

const TMPQ = new THREE.Quaternion();
const WHITE = new THREE.Color(1, 1, 1);
let ringGeo: THREE.RingGeometry | null = null;
let discGeo: THREE.CircleGeometry | null = null;
let barGeo: THREE.PlaneGeometry | null = null;

export class HpBar {
  readonly group = new THREE.Group();
  readonly fg: THREE.Mesh;
  readonly bg: THREE.Mesh;
  private bgMat: THREE.MeshBasicMaterial;
  private fgMat: THREE.MeshBasicMaterial;
  frac = 1;

  constructor() {
    barGeo ??= new THREE.PlaneGeometry(1, 1);
    // Both materials must sit in the same (transparent) render list: three.js draws every opaque
    // object before any transparent one, so an opaque fill under a transparent background would be
    // painted over by it whatever the renderOrder. Within one list renderOrder decides (bg, then fg).
    // Fog and tone mapping would darken / shift the status colours, so both are off.
    const common = { transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false } as const;
    this.bgMat = new THREE.MeshBasicMaterial({ ...common, color: 0x14141a, opacity: 0.8 });
    this.fgMat = new THREE.MeshBasicMaterial({ ...common, color: 0x5fe08a, opacity: 1 });
    const bg = (this.bg = new THREE.Mesh(barGeo, this.bgMat));
    bg.scale.set(0.62, 0.085, 1);
    bg.renderOrder = 998;
    this.fg = new THREE.Mesh(barGeo, this.fgMat);
    this.fg.renderOrder = 999;
    this.fg.position.z = 0.001;
    this.group.add(bg, this.fg);
    this.group.visible = false;
    this.set(1);
  }

  set(frac: number): void {
    this.frac = Math.max(0, Math.min(1, frac));
    const w = 0.58 * this.frac;
    this.fg.scale.set(Math.max(0.0001, w), 0.055, 1);
    this.fg.position.x = -0.29 + w / 2;
    this.fgMat.color.set(this.frac > 0.6 ? '#5fe08a' : this.frac > 0.3 ? '#f2c14e' : '#ff5a4a');
  }

  dispose(): void {
    this.bgMat.dispose();
    this.fgMat.dispose();
  }
}

export interface ActorView {
  id: string;
  defId: string;
  /** positioned at the tile centre; rotation.y = facing */
  root: THREE.Group;
  /** holds the model; offset by lunges/knockbacks without disturbing root */
  inner: THREE.Group;
  model: THREE.Object3D;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  hp: HpBar;
  height: number;
  faction: Faction | 'ally';
  isPlayer: boolean;
  /** logical tile (the end of any running tween) */
  tile: Pos;
  motion: Motion;
  dying: boolean;
  /** visibility from fog of war; the renderer fades views in and out */
  shown: boolean;
  opacity: number;
  light?: { color: string; intensity: number; radius: number };
  /** cloned materials when fading (so shared materials are untouched) */
  fadeMats?: THREE.Material[];
}

export class ActorLayer {
  readonly group = new THREE.Group();
  readonly views = new Map<string, ActorView>();
  private templates = new Map<string, THREE.Group>();
  /** actor-owned copies of the shared model materials (so the light floor never touches terrain) */
  private ownMats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  private world: WorldSpec;
  /** emissive floor (fraction of each material's base colour) so actors stay readable in dark areas */
  lightFloor = 0;

  constructor(world: WorldSpec) {
    this.world = world;
    this.group.name = 'actors';
  }

  private spec(defId: string): ModelSpec {
    if (defId === 'player') return this.world.player.model;
    return this.world.actors.find((a) => a.id === defId)?.model ?? DEFAULT_MODEL;
  }

  private template(defId: string): THREE.Group {
    let t = this.templates.get(defId);
    if (!t) {
      t = buildModel(this.spec(defId), { lights: false });
      t.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = Array.isArray(m.material) ? m.material.map((x) => this.own(x)) : this.own(m.material);
      });
      this.templates.set(defId, t);
    }
    return t;
  }

  private own(src: THREE.Material): THREE.Material {
    const std = src as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) return src;
    let c = this.ownMats.get(src);
    if (!c) {
      c = std.clone();
      c.userData.cached = false;
      // materials that already glow keep their own emissive; the floor only lifts unlit ones
      const glows = std.emissive.getHex() !== 0 && std.emissiveIntensity > 0;
      // lifted towards white so dark clothing / skin still reads as a silhouette, not a hole
      c.userData.floorBase = glows ? null : std.color.clone().lerp(WHITE, 0.3);
      ActorLayer.applyFloor(c, this.lightFloor);
      this.ownMats.set(src, c);
    }
    return c;
  }

  private static applyFloor(m: THREE.Material, k: number): void {
    const base = m.userData.floorBase as THREE.Color | null | undefined;
    const std = m as THREE.MeshStandardMaterial;
    if (!base || !std.emissive) return;
    std.emissive.copy(base).multiplyScalar(k);
    std.emissiveIntensity = 1;
  }

  /**
   * Minimum self-illumination of every actor model (0 = none). Actors on tiles the engine reports as
   * visible must be readable however dark the area's lighting is; the renderer sets this per area.
   */
  setLightFloor(k: number): void {
    this.lightFloor = Math.max(0, Math.min(1, k));
    for (const m of this.ownMats.values()) ActorLayer.applyFloor(m, this.lightFloor);
    for (const v of this.views.values()) for (const m of v.fadeMats ?? []) ActorLayer.applyFloor(m, this.lightFloor);
  }

  static factionOf(a: ActorInstance, isPlayer: boolean): Faction | 'ally' {
    if (isPlayer) return 'player';
    if (a.allyOf) return 'ally';
    return a.faction;
  }

  ensure(a: ActorInstance, isPlayer: boolean): ActorView {
    const existing = this.views.get(a.id);
    if (existing) return existing;
    const tpl = this.template(a.defId);
    const model = tpl.clone();
    model.userData.phase = (hashStr(a.id) % 628) / 100;
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    const root = new THREE.Group();
    root.name = `actor:${a.id}`;
    root.position.set(a.pos.x, 0, a.pos.y);
    const inner = new THREE.Group();
    inner.add(model);
    root.add(inner);

    ringGeo ??= new THREE.RingGeometry(0.33, 0.43, 36);
    discGeo ??= new THREE.CircleGeometry(0.33, 28);
    const faction = ActorLayer.factionOf(a, isPlayer);
    // the faction ring is a status marker: fog and tone mapping must not darken it in dim areas
    const ringMat = new THREE.MeshBasicMaterial({ color: col(FACTION_COLORS[faction]), transparent: true, opacity: isPlayer ? 0.9 : 0.65, depthWrite: false, fog: false, toneMapped: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    ring.renderOrder = 2;
    // soft dark disc grounds the model (contact shadow)
    const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    disc.renderOrder = 1;
    disc.position.set(0, 0, -0.002); // ring-local: just below the ring
    ring.add(disc);
    root.add(ring);

    const height = modelHeight(tpl);
    const hp = new HpBar();
    hp.group.position.y = Math.min(2.6, height + 0.22);
    root.add(hp.group);

    const spec = this.spec(a.defId);
    const view: ActorView = {
      id: a.id,
      defId: a.defId,
      root,
      inner,
      model,
      ring,
      ringMat,
      hp,
      height,
      faction,
      isPlayer,
      tile: { ...a.pos },
      motion: {},
      dying: false,
      shown: true,
      opacity: 1,
      light: spec.light && spec.light.intensity > 0 ? { ...spec.light } : undefined,
    };
    this.views.set(a.id, view);
    this.group.add(root);
    return view;
  }

  setFaction(v: ActorView, f: Faction | 'ally'): void {
    if (v.faction === f) return;
    v.faction = f;
    v.ringMat.color.set(FACTION_COLORS[f]);
  }

  /** Make a view's materials fadeable (clones them once). */
  setOpacity(v: ActorView, o: number): void {
    v.opacity = o;
    if (!v.fadeMats) {
      v.fadeMats = [];
      const map = new Map<THREE.Material, THREE.Material>();
      v.model.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const src = m.material as THREE.Material;
        let c = map.get(src);
        if (!c) {
          c = src.clone();
          c.userData.floorBase = src.userData.floorBase ? (src.userData.floorBase as THREE.Color).clone() : null;
          c.userData.baseOpacity = (src as THREE.MeshStandardMaterial).opacity ?? 1;
          c.transparent = true;
          map.set(src, c);
          v.fadeMats!.push(c);
        }
        m.material = c;
      });
    }
    for (const m of v.fadeMats) m.opacity = (m.userData.baseOpacity ?? 1) * o;
    v.ringMat.opacity = (v.isPlayer ? 0.9 : 0.65) * o;
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.hp.dispose();
    v.ringMat.dispose();
    v.ring.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m !== v.ring && m.isMesh) (m.material as THREE.Material).dispose();
    });
    for (const m of v.fadeMats ?? []) m.dispose();
    this.views.delete(id);
  }

  update(t: number, camera: THREE.Camera): void {
    for (const v of this.views.values()) {
      if (!v.root.visible) continue;
      animateModel(v.model, t, v.motion);
      if (v.hp.group.visible) v.hp.group.quaternion.copy(camera.quaternion).premultiply(TMPQ.copy(v.root.quaternion).invert());
      if (v.isPlayer) {
        const k = 1 + Math.sin(t * 3) * 0.04;
        v.ring.scale.set(k, k, k);
      }
    }
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
    this.templates.clear();
    for (const m of this.ownMats.values()) m.dispose();
    this.ownMats.clear();
  }
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
