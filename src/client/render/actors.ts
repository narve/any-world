/**
 * Actor views: one model per actor instance with a faction ring under it and a billboard hp bar.
 * Positions/animation are driven by the Renderer; this layer owns construction and per-frame idle.
 */
import * as THREE from 'three';
import type { WorldSpec, ModelSpec } from '../../schema/world';
import type { ActorInstance, Faction, Pos } from '../../engine/types';
import { buildModel, animateModel, modelHeight, type Motion } from './models';
import { compactModel } from './models/merge';
import { col, luminance, mixHex } from './color';

/** every actor model is drawn a little larger than its spec so it reads at the default zoom */
export const ACTOR_SCALE = 1.12;
/** small creatures are scaled up to at least this height (tiles) */
export const MIN_ACTOR_HEIGHT = 0.55;
/** outline thickness (world units) around actor silhouettes */
export const OUTLINE = 0.022;

/** Scale for a model of natural height `h` (already including its spec scale). */
export function actorScaleFor(h: number): number {
  const k = ACTOR_SCALE;
  return h * k < MIN_ACTOR_HEIGHT ? MIN_ACTOR_HEIGHT / Math.max(0.05, h) : k;
}

/**
 * True when a model's main colour would melt into the floor (similar lightness): such actors get a
 * thicker, brighter outline and a stronger rim light.
 */
export function lowContrast(modelColor: string | undefined, floorColor: string | undefined): boolean {
  if (!modelColor || !floorColor) return false;
  return Math.abs(luminance(modelColor) - luminance(floorColor)) < 0.16;
}

/** outline colour per faction: the faction colour, a little deeper so it frames rather than glows */
function outlineColor(f: Faction | 'ally', strong: boolean): string {
  return mixHex(FACTION_COLORS[f], '#000000', strong ? 0.1 : 0.45);
}

/** shared rim-light uniform (view-space fresnel, stronger from above); its strength follows the area's darkness */
const RIM = { value: new THREE.Color(0.22, 0.22, 0.24) };

function addRim(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return;
  // merged vertex-coloured parts: the light floor (a uniform emissive) follows each vertex's colour
  const vertexFloor = !!std.vertexColors && !!std.userData.vertexFloor;
  std.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = RIM;
    if (vertexFloor) {
      // per-vertex roughness / metalness of the merged parts (see compactModel)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRough;\nattribute float aMetal;\nvarying float vRough;\nvarying float vMetal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough;\nvMetal = aMetal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRough;\nvarying float vMetal;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMetal;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        ${vertexFloor ? '#ifdef USE_COLOR\n totalEmissiveRadiance *= mix(vec3(1.0), vColor.rgb, 0.7);\n#endif' : ''}
        {
          vec3 vdir = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(abs(dot(normal, vdir)), 0.0, 1.0), 2.5);
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float top = 0.45 + 0.55 * max(0.0, dot(normal, upV));
          totalEmissiveRadiance += uRim * fres * top;
        }`,
      );
  };
  std.customProgramCacheKey = () => (vertexFloor ? 'actor-rim-vc' : 'actor-rim');
}

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
let pulseGeo: THREE.RingGeometry | null = null;
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
  /** player only: an expanding, fading second ring */
  pulse?: THREE.Mesh;
  /** silhouette outline meshes (inverted hulls in the faction colour) */
  outlines: THREE.Mesh[];
  /** low contrast against the floor: stronger outline */
  lowContrast: boolean;
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
  /** outlined + merged copies of the templates, per defId and outline strength (what views clone) */
  private compact = new Map<string, { model: THREE.Group; natural: number }>();
  /** actor-owned copies of the shared model materials (so the light floor never touches terrain) */
  private ownMats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  private world: WorldSpec;
  /** emissive floor (fraction of each material's base colour) so actors stay readable in dark areas */
  lightFloor = 0;
  /** floor colour of the current area (for the automatic contrast lift) */
  groundColor: string | undefined;
  private outlineMats = new Map<string, THREE.MeshBasicMaterial>();
  /** MP3: ring colours of a room's players by actor id (their seat colours), over the faction colour */
  private partyColours = new Map<string, string>();

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
      addRim(c);
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
    const r = 0.16 + this.lightFloor * 0.9;
    RIM.value.setRGB(r, r, r * 1.08);
    for (const m of this.ownMats.values()) ActorLayer.applyFloor(m, this.lightFloor);
    for (const v of this.views.values()) for (const m of v.fadeMats ?? []) ActorLayer.applyFloor(m, this.lightFloor);
  }

  static factionOf(a: ActorInstance, isPlayer: boolean): Faction | 'ally' {
    if (isPlayer) return 'player';
    if (a.allyOf) return 'ally';
    return a.faction;
  }

  /**
   * The model a view clones: the template scaled for display, with silhouette outlines added and
   * every rigid part merged per material (compactModel), so an actor costs a handful of draw calls
   * instead of two per primitive. Cached per defId and outline strength.
   */
  private compactTemplate(defId: string, weak: boolean): { model: THREE.Group; natural: number } {
    const key = `${defId}|${weak ? 1 : 0}`;
    let c = this.compact.get(key);
    if (!c) {
      const tpl = this.template(defId);
      const natural = modelHeight(tpl);
      const model = tpl.clone();
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      model.scale.multiplyScalar(actorScaleFor(natural));
      this.addOutlines(model, 'neutral', weak);
      compactModel(model, { colorClass: (m) => this.colorClass(m), vertexColorMaterial: (m) => this.vertexColorMat(m) });
      c = { model, natural };
      this.compact.set(key, c);
    }
    return c;
  }

  /**
   * Opaque standard materials without their own glow merge into one vertex-coloured class per side;
   * colour, roughness and metalness travel per vertex.
   */
  private colorClass(m: THREE.Material): string | null {
    const std = m as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial || std.transparent || std.map || std.vertexColors || !std.userData.floorBase) return null;
    return [std.side, std.alphaTest].join('|');
  }

  private vcMats = new Map<string, THREE.MeshStandardMaterial>();

  /** a white, vertex-coloured copy of an actor material whose light floor follows the vertex colours */
  private vertexColorMat(src: THREE.Material): THREE.Material {
    const key = this.colorClass(src) ?? src.uuid;
    let m = this.vcMats.get(key);
    if (!m) {
      m = (src as THREE.MeshStandardMaterial).clone();
      m.color.set(1, 1, 1);
      m.vertexColors = true;
      m.flatShading = false; // flat parts carry baked face normals
      m.roughness = 1;
      m.metalness = 0;
      m.userData = { cached: false, vertexFloor: true, floorBase: WHITE.clone() };
      ActorLayer.applyFloor(m, this.lightFloor);
      addRim(m);
      this.vcMats.set(key, m);
      this.ownMats.set(m, m);
    }
    return m;
  }

  ensure(a: ActorInstance, isPlayer: boolean): ActorView {
    const existing = this.views.get(a.id);
    if (existing) return existing;
    const faction0 = ActorLayer.factionOf(a, isPlayer);
    const weak = !isPlayer && lowContrast(this.spec(a.defId).colors?.primary, this.groundColor);
    const ct = this.compactTemplate(a.defId, weak);
    const natural = ct.natural;
    const model = ct.model.clone();
    model.userData.phase = (hashStr(a.id) % 628) / 100;
    const outlines: THREE.Mesh[] = [];
    const omat = this.outlineMat(faction0, weak);
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.userData.outline) {
        (o as THREE.Mesh).material = omat;
        outlines.push(o as THREE.Mesh);
      }
    });
    const root = new THREE.Group();
    root.name = `actor:${a.id}`;
    root.position.set(a.pos.x, 0, a.pos.y);
    const inner = new THREE.Group();
    inner.add(model);
    root.add(inner);

    ringGeo ??= new THREE.RingGeometry(0.34, 0.45, 40);
    discGeo ??= new THREE.CircleGeometry(0.34, 28);
    const faction = faction0;
    // the faction ring is a status marker: fog and tone mapping must not darken it in dim areas; it
    // sits above floor decals (patches, liquids) so terrain never covers it
    const ringMat = new THREE.MeshBasicMaterial({ color: col(this.partyColours.get(a.id) ?? FACTION_COLORS[faction]), transparent: true, opacity: isPlayer ? 1 : 0.72, depthWrite: false, fog: false, toneMapped: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.045;
    ring.renderOrder = 4;
    // soft dark disc grounds the model (contact shadow)
    const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    disc.renderOrder = 1;
    disc.position.set(0, 0, -0.002); // ring-local: just below the ring
    ring.add(disc);
    root.add(ring);
    const pulse = isPlayer ? this.makePulse(this.partyColours.get(a.id) ?? FACTION_COLORS.player) : undefined;
    if (pulse) root.add(pulse);

    const height = natural * actorScaleFor(natural);
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
      pulse,
      outlines,
      lowContrast: weak,
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

  /** the player's expanding second ring */
  private makePulse(colour: string): THREE.Mesh {
    pulseGeo ??= new THREE.RingGeometry(0.42, 0.47, 40);
    const pulse = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: col(colour), transparent: true, opacity: 0.5, depthWrite: false, fog: false, toneMapped: false }));
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.05;
    pulse.renderOrder = 4;
    pulse.name = 'player-pulse';
    return pulse;
  }

  /** the ring colour of a view: its seat colour in a room, else its faction's */
  ringColour(v: Pick<ActorView, 'id' | 'faction'>): string {
    return this.partyColours.get(v.id) ?? FACTION_COLORS[v.faction];
  }

  /**
   * MP3: a room's players by actor id → seat colour. Their existing rings (and the followed player's
   * pulse) are recoloured at once and new views take the colour; actors not in the map keep their
   * faction colour. Single player never calls this.
   */
  setPartyColours(colours: ReadonlyMap<string, string>): void {
    this.partyColours = new Map(colours);
    for (const v of this.views.values()) {
      v.ringMat.color.set(this.ringColour(v));
      if (v.pulse) (v.pulse.material as THREE.MeshBasicMaterial).color.set(this.partyColours.get(v.id) ?? FACTION_COLORS.player);
    }
  }

  /**
   * MP3: the camera now follows `actorId` (a room's spectator watches a teammate). Views were flagged
   * as "the player" when made (always shown, full ring, pulse, see-through, ghosted when sneaking);
   * this moves the flag to `actorId`'s view and clears it on every other one.
   */
  setFollow(actorId: string | null): void {
    for (const v of this.views.values()) this.setPlayerFlag(v, v.id === actorId);
  }

  private setPlayerFlag(v: ActorView, on: boolean): void {
    if (v.isPlayer === on) return;
    v.isPlayer = on;
    if (on && !v.pulse) {
      v.pulse = this.makePulse(this.partyColours.get(v.id) ?? FACTION_COLORS.player);
      v.root.add(v.pulse);
    } else if (!on && v.pulse) {
      v.root.remove(v.pulse);
      (v.pulse.material as THREE.Material).dispose();
      v.pulse = undefined;
      v.ring.scale.set(1, 1, 1);
    }
    v.ringMat.opacity = (on ? 1 : 0.72) * v.opacity;
  }

  setFaction(v: ActorView, f: Faction | 'ally'): void {
    if (v.faction === f) return;
    v.faction = f;
    v.ringMat.color.set(this.ringColour(v));
    const m = this.outlineMat(f, v.lowContrast);
    for (const o of v.outlines) if (!(o.material as THREE.Material).userData.fade) o.material = m;
  }

  private outlineMat(f: Faction | 'ally', strong: boolean): THREE.MeshBasicMaterial {
    const key = `${f}|${strong}`;
    let m = this.outlineMats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: col(outlineColor(f, strong)), side: THREE.BackSide, fog: false, toneMapped: false });
      m.userData.outline = true;
      this.outlineMats.set(key, m);
    }
    return m;
  }

  /**
   * Inverted-hull outlines: a back-face copy of every mesh, grown by OUTLINE world units around its
   * own centre, in the faction colour. Children of the meshes they outline, so animation carries them.
   */
  private addOutlines(model: THREE.Object3D, f: Faction | 'ally', strong: boolean): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const meshes: THREE.Mesh[] = [];
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.outline) meshes.push(m);
    });
    const mat = this.outlineMat(f, strong);
    const t = OUTLINE * (strong ? 1.6 : 1);
    const ws = new THREE.Vector3();
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    for (const m of meshes) {
      const mm = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      // see-through parts (glass, glows) are not outlined
      if (mm?.transparent && (mm.opacity ?? 1) < 0.9) continue;
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      g.boundingBox!.getSize(size);
      g.boundingBox!.getCenter(centre);
      m.getWorldScale(ws);
      const sx = 1 + (2 * t) / Math.max(0.02, size.x * Math.abs(ws.x));
      const sy = 1 + (2 * t) / Math.max(0.02, size.y * Math.abs(ws.y));
      const sz = 1 + (2 * t) / Math.max(0.02, size.z * Math.abs(ws.z));
      const o = new THREE.Mesh(g, mat);
      o.userData.outline = true;
      o.userData.noDim = true;
      o.castShadow = false;
      o.receiveShadow = false;
      o.scale.set(sx, sy, sz);
      o.position.set(centre.x * (1 - sx), centre.y * (1 - sy), centre.z * (1 - sz));
      o.renderOrder = -1;
      m.add(o);
      out.push(o);
    }
    return out;
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
          c.userData.fade = true;
          c.transparent = true;
          if (!src.userData.outline) addRim(c);
          map.set(src, c);
          v.fadeMats!.push(c);
        }
        m.material = c;
      });
    }
    for (const m of v.fadeMats) m.opacity = (m.userData.baseOpacity ?? 1) * o;
    v.ringMat.opacity = (v.isPlayer ? 1 : 0.72) * o;
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.hp.dispose();
    v.ringMat.dispose();
    if (v.pulse) (v.pulse.material as THREE.Material).dispose();
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
        const k = 1 + Math.sin(t * 3) * 0.05;
        v.ring.scale.set(k, k, k);
        if (v.pulse) {
          const p = (t * 0.7) % 1;
          const s = 1 + p * 0.55;
          v.pulse.scale.set(s, s, s);
          (v.pulse.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - p) * v.opacity;
        }
      }
    }
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
    this.templates.clear();
    this.vcMats.clear();
    for (const c of this.compact.values()) c.model.traverse((o) => (o as THREE.Mesh).isMesh && !(o as THREE.Mesh).geometry.userData.shared && (o as THREE.Mesh).geometry.dispose());
    this.compact.clear();
    for (const m of this.ownMats.values()) m.dispose();
    this.ownMats.clear();
    for (const m of this.outlineMats.values()) m.dispose();
    this.outlineMats.clear();
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
