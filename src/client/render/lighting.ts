/**
 * Lighting rig driven by AreaPlan.lighting: hemisphere ambient, optional sun with shadows, a camera
 * fill light, fog and background, plus fixed-size pools of point lights (lamps nearest the player,
 * the player's own light, and a few model lights). Pool sizes never change so shaders never recompile
 * mid-game; unused lights simply get intensity 0.
 */
import * as THREE from 'three';
import type { AreaPlan } from '../../schema/world';
import { col, shade, mixHex } from './color';
import type { LampView } from './tiles';

export const LAMP_LIGHTS = 10;
export const MODEL_LIGHTS = 3;

export interface ModelLightRequest {
  pos: THREE.Vector3;
  color: string;
  intensity: number;
  radius: number;
}

export class LightRig {
  readonly group = new THREE.Group();
  readonly hemi: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly player: THREE.PointLight;
  readonly lamps: THREE.PointLight[] = [];
  readonly models: THREE.PointLight[] = [];
  private lighting: AreaPlan['lighting'] | null = null;
  private sunDir = new THREE.Vector3(0.4, 1, 0.6).normalize();
  private hasSun = false;
  private lampIntensity = 0;
  private playerIntensity = 0;
  private playerLightBase = 1;
  /** how far (tiles) the engine currently lets the player see; drives fog start and the player light */
  private sightRadius = 0;
  /**
   * Emissive floor for actor models (see ActorLayer.setLightFloor): darker areas get more, so anything
   * on a tile the engine reports as visible is readable even far from lamps and the player's light.
   */
  actorLightFloor = 0;
  background = new THREE.Color('#101014');
  private tmp: { l: LampView; d: number }[] = [];

  constructor() {
    this.group.name = 'lights';
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -16;
    sc.right = 16;
    sc.top = 16;
    sc.bottom = -16;
    sc.near = 1;
    sc.far = 80;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.group.add(this.sun, this.sun.target);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.3);
    this.group.add(this.fill, this.fill.target);
    this.player = new THREE.PointLight(0xfff1dd, 0, 6, 1.3);
    this.group.add(this.player);
    for (let i = 0; i < LAMP_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffcc88, 0, 6, 1.6);
      this.lamps.push(l);
      this.group.add(l);
    }
    for (let i = 0; i < MODEL_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 3, 1.6);
      this.models.push(l);
      this.group.add(l);
    }
  }

  /** how many lamp / model lights may be live (render quality); the rest are hidden */
  private lampBudget = LAMP_LIGHTS;
  private modelBudget = MODEL_LIGHTS;
  private shadowsAllowed = true;

  /**
   * Render quality: live point lights and sun shadows. Hidden lights are left out of the shader, so
   * a lower budget is cheaper per fragment (changing it recompiles the materials once).
   */
  setBudget(opts: { lamps: number; models: number; shadows: boolean; shadowMapSize?: number }): void {
    this.lampBudget = Math.max(0, Math.min(LAMP_LIGHTS, Math.floor(opts.lamps)));
    this.modelBudget = Math.max(0, Math.min(MODEL_LIGHTS, Math.floor(opts.models)));
    this.lamps.forEach((l, i) => (l.visible = i < this.lampBudget));
    this.models.forEach((l, i) => (l.visible = i < this.modelBudget));
    this.shadowsAllowed = opts.shadows;
    this.sun.castShadow = this.hasSun && this.shadowsAllowed;
    const size = opts.shadowMapSize ?? 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  /** number of point lights currently allowed to shine (player + lamps + models) */
  get liveLights(): number {
    return 1 + this.lampBudget + this.modelBudget;
  }

  configure(lighting: AreaPlan['lighting'], scene: THREE.Scene): void {
    this.lighting = lighting;
    const amb = lighting.ambient ?? '#808080';
    const ai = lighting.ambientIntensity ?? 0.4;
    // keep a readable floor of light even in very dark areas; the ambient colour sets the mood
    this.hemi.color = col(mixHex(amb, '#ffffff', 0.3));
    this.hemi.groundColor = col(shade(amb, 0.5));
    this.hemi.intensity = 0.7 + ai * 2.0;
    this.hasSun = !!lighting.sun && lighting.sun.intensity > 0;
    if (lighting.sun) {
      const e = ((lighting.sun.elevation ?? 50) * Math.PI) / 180;
      const az = 0.65; // from the south-east so shadows fall away from the default camera
      this.sunDir.set(Math.cos(e) * Math.sin(az), Math.sin(e), Math.cos(e) * Math.cos(az)).normalize();
      this.sun.color = col(lighting.sun.color);
      this.sun.intensity = lighting.sun.intensity * 1.7;
    } else {
      this.sun.intensity = 0;
    }
    this.sun.castShadow = this.hasSun && this.shadowsAllowed;
    this.fill.color = col(mixHex(amb, '#ffffff', 0.5));
    this.fill.intensity = this.hasSun ? 0.25 : 0.35 + ai * 0.5;
    const lampC = lighting.lamps?.color ?? '#ffcc88';
    this.lampIntensity = lighting.lamps ? lighting.lamps.intensity : 0;
    for (const l of this.lamps) {
      l.color = col(lampC);
      l.intensity = 0;
    }
    const pl = lighting.playerLight ?? 4;
    this.playerIntensity = pl > 0 ? 3 + pl * 0.6 : 0;
    this.playerLightBase = Math.max(1, pl * 2.2);
    this.player.distance = this.playerLightDistance();
    this.player.decay = 1;
    // the floor fades out as the area's own light gets brighter; sunlit areas need none
    this.actorLightFloor = this.hasSun ? 0.05 : Math.max(0.06, Math.min(0.3, 0.34 - ai * 0.6));
    this.player.color = col(lighting.lamps?.color ? mixHex(lighting.lamps.color, '#fff4e0', 0.6) : '#fff1dd');

    const fogC = lighting.fog?.color;
    this.background = col(lighting.sky ?? fogC ?? shade(amb, 0.14));
    scene.background = this.background;
    // linear fog measured from the camera's focus distance, so the player's surroundings stay clear
    // and density only decides how quickly the distance fades out
    if (lighting.fog && lighting.fog.density > 0) {
      this.fog = new THREE.Fog(col(lighting.fog.color).getHex(), 10, 40);
      this.fogDepth = Math.min(60, Math.max(7, 1.1 / lighting.fog.density));
      scene.fog = this.fog;
    } else {
      this.fog = null;
      scene.fog = null;
    }
  }

  private fog: THREE.Fog | null = null;
  private fogDepth = 30;

  private playerLightDistance(): number {
    // reach at least one tile past the farthest visible tile, so the light and the engine's sight agree
    return Math.max(this.playerLightBase, this.sightRadius > 0 ? this.sightRadius + 1.5 : 0);
  }

  /**
   * The player's current sight radius in tiles (the farthest tile the engine marks visible). Fog only
   * starts beyond it and the player's light reaches it, so nothing the engine shows the player is lost
   * in darkness or fog. 0 = unknown (falls back to the lighting plan).
   */
  setSightRadius(r: number): void {
    this.sightRadius = Math.max(0, r);
    this.player.distance = this.playerLightDistance();
  }

  get sight(): number {
    return this.sightRadius;
  }

  /** where fog starts / ends for a camera at `cameraDistance` from the focus */
  fogRange(cameraDistance: number): { near: number; far: number } {
    // tiles beyond the focus lie up to ~cos(pitch)·r further from the camera than the focus
    const pad = this.sightRadius * 0.65;
    const near = Math.max(1, cameraDistance - 2 + pad);
    return { near, far: near + 2 + this.fogDepth };
  }

  /** keep fog relative to the camera distance (call when zoom changes) */
  updateFog(cameraDistance: number): void {
    if (!this.fog) return;
    const { near, far } = this.fogRange(cameraDistance);
    this.fog.near = near;
    this.fog.far = far;
  }

  /**
   * Per-frame update. `focus` is the camera target (player), `camPos` the camera position,
   * `lamps` the area's lamp views and `modelLights` pending model light requests (nearest first).
   */
  update(t: number, focus: THREE.Vector3, camPos: THREE.Vector3, lamps: LampView[], modelLights: ModelLightRequest[]): void {
    if (this.hasSun) {
      this.sun.position.copy(focus).addScaledVector(this.sunDir, 30);
      this.sun.target.position.copy(focus);
      this.sun.target.updateMatrixWorld();
    }
    this.fill.position.copy(camPos);
    this.fill.target.position.copy(focus);
    this.fill.target.updateMatrixWorld();

    this.player.position.set(focus.x, 1.3, focus.z);
    this.player.intensity = this.playerIntensity;

    // nearest visible lamps get real lights
    const list = this.tmp;
    list.length = 0;
    for (const l of lamps) {
      if (!l.visible) continue;
      list.push({ l, d: l.pos.distanceToSquared(focus) });
    }
    list.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lamps.length; i++) {
      const pl = this.lamps[i];
      const e = i < this.lampBudget ? list[i] : undefined;
      if (!e || this.lampIntensity <= 0) {
        pl.intensity = 0;
        continue;
      }
      pl.position.copy(e.l.pos);
      // fade lights in by distance so swapping lamps in/out of the pool doesn't pop
      const fade = i < this.lampBudget - 2 ? 1 : 0.5;
      pl.intensity = this.lampIntensity * 3.2 * e.l.flicker * fade;
    }
    for (let i = 0; i < this.models.length; i++) {
      const ml = this.models[i];
      const r = i < this.modelBudget ? modelLights[i] : undefined;
      if (!r) {
        ml.intensity = 0;
        continue;
      }
      ml.position.copy(r.pos);
      ml.color.set(r.color);
      ml.intensity = r.intensity * 2.2;
      ml.distance = Math.max(0.8, r.radius * 1.8);
    }
  }
}
