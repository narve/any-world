/**
 * AnyWorld three.js renderer.
 *
 * Public API
 * ----------
 *   const r = new Renderer(container: HTMLElement, opts?: RendererOptions)
 *   r.setWorld(world: WorldSpec): void                 // models/vocabulary for a run; resets the scene
 *   r.setArea(area: AreaState, world?: WorldSpec): void // builds static geometry + lighting for an area
 *   await r.sync(state: GameState, events: GameEvent[]) // animate a turn's events, then match `state`
 *       - moves tween (~120 ms), melee lunges / ranged bolts, floating damage/heal numbers, misses,
 *         status names, deaths topple + fade, Action.vfx effects (bolt/burst/beam/cloud/sparkle/slash/ring),
 *         item pickups fly to the player, spawns pop in, doors open, terrain changes rebuild.
 *       - fog of war is taken from the lead player's seen (0 unseen, 1 remembered, 2 visible). Actors and floor
 *         items are only shown on visible tiles; the player is always shown. Every actor on a visible
 *         tile is kept drawable: walls on its sight line to the camera are cut away, the camera zooms
 *         out (never in) to keep it on screen, fog starts beyond the sight radius and actor models get
 *         an emissive light floor in dark areas.
 *       - resolves as soon as the blocking animations finish (≤ ~0.5 s), or immediately after
 *         skipAnimations(). Calling sync again while animating fast-forwards the previous turn.
 *       - switches area automatically if state.area.index changed.
 *   r.skipAnimations(): void                           // jump every running animation to its end
 *   r.rotateCamera(dir: -1 | 1): void                  // animated 90° orbit steps
 *   r.zoom(delta: number): void                        // delta > 0 zooms out (wheel deltaY / 100 works)
 *   r.screenToTile(clientX: number, clientY: number): Pos | null   // viewport coords (MouseEvent.clientX/Y)
 *   r.highlightTiles(positions: Pos[], color?: string): void       // [] clears
 *   r.setReduceMotion(on: boolean): void               // freeze cosmetic motion (backdrop, ripples)
 *   r.resize(): void                                   // also automatic via ResizeObserver
 *   r.dispose(): void
 *
 * Mobile / performance (DESIGN §6b)
 *   r.setQuality('auto' | 'low' | 'high'): void        // 'auto' (default): low on phones / touch or
 *                                                      // when frames are slow (adaptive, hysteresis)
 *   r.quality: { setting, tier, profile }              // what is in effect now
 *   r.stats(): RenderStats                             // { drawCalls, triangles, fps, ... } of the last frame
 *   r.pick(clientX, clientY): Pos | null               // tapped tile; a tap on an actor's body gives its tile
 *   r.zoomBy(f: number): void                          // pinch: f > 1 zooms in (camera closer)
 *   r.rotateStep(dir: -1 | 1): void                    // 90° step (same as rotateCamera)
 *   r.setViewportInsets({ top, bottom, left, right })  // CSS px covered by HUD / hotbar / safe areas;
 *                                                      // the player is centred in the rest
 *   r.setOverlayRects([{ left, top, right, bottom }])  // viewport CSS px of panels over the map (HUD,
 *                                                      // log, hotbar, goal bar…): auto framing shifts the
 *                                                      // view (or zooms out) until no visible actor is
 *                                                      // under one. Panels found over a framed actor
 *                                                      // (document.elementFromPoint, once the camera
 *                                                      // rests) are added on their own: see autoOverlays
 *   r.autoOverlays: boolean                            // default true; false = only setOverlayRects
 *   r.itemThumbnail(defId): string | null              // cached PNG data URL of the item's model
 *   r.onContextChange = (lost: boolean) => …           // WebGL context lost / restored (rebuilt in place)
 *   attachTouchCamera(r, el)                           // pinch + twist gestures (see touch.ts)
 *
 * Coordinates: tile (x, y) is centred at world (x, 0, y); see coords.ts. Models: see models/index.ts.
 */
import * as THREE from 'three';
import type { WorldSpec, AreaPlan } from '../../schema/world';
import type { AreaState, GameEvent, GameState, Pos, ActorInstance } from '../../engine/types';
import { CameraRig } from './camera';
import { LightRig, type ModelLightRequest } from './lighting';
import { AreaView, type FoggedArea, type SeenArray } from './tiles';
import { ActorLayer, type ActorView } from './actors';
import { ItemLayer } from './items';
import { VfxLayer } from './vfx';
import { Animator, ease } from './tween';
import { cutawayTiles, occluderTiles } from './cutaway';
import { facingAngle, inBounds, worldToTile } from './coords';
import { col } from './color';
import { clearMaterialCache } from './materials';
import { clearTextureCache } from './textures';
import { Backdrop } from './backdrop';
import { disposeSurfaceTextures } from './surfaces';
import { AdaptiveQuality, FpsMeter, QUALITY_PROFILES, browserDeviceHints, initialTier, isMobileDevice, type DeviceHints, type QualityProfile, type QualitySetting, type QualityTier } from './quality';
import type { ViewInsets, OverlayRect } from './camera';
import { missLabel } from '../i18n/engine-text';
import { ItemThumbnailer } from './thumbnails';
import { leadPlayer } from '../../engine/index';

export { buildModel, animateModel } from './models';
export type { ModelSpecIn } from './models';
export { towardCamera, tileCentre, worldToTile } from './coords';
export { attachTouchCamera, TouchCameraGesture } from './touch';
export { QUALITY_PROFILES, isMobileDevice } from './quality';
export type { QualitySetting, QualityTier, QualityProfile } from './quality';
export type { ViewInsets, OverlayRect } from './camera';
export { THUMB_SIZE } from './thumbnails';

/** What the last rendered frame cost (Renderer.stats()). */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** frames per second, smoothed over ~0.5 s (0 until measured) */
  fps: number;
  geometries: number;
  textures: number;
  programs: number;
  tier: QualityTier;
  pixelRatio: number;
  contextLost: boolean;
}

export interface RendererOptions {
  antialias?: boolean;
  /** cap on devicePixelRatio (default 2) */
  maxPixelRatio?: number;
  /** shadows from the sun (default true) */
  shadows?: boolean;
  /**
   * Freeze purely cosmetic motion (backdrop drift, water ripples). Default: the OS
   * `prefers-reduced-motion` setting. Change later with setReduceMotion().
   */
  reduceMotion?: boolean;
  /** render quality (default 'auto'); change later with setQuality() */
  quality?: QualitySetting;
  /** device facts used by 'auto' (default: read from the browser); for tests */
  device?: DeviceHints;
}

const MOVE_MS = 120;
/** while the camera rests, the page is checked for panels over framed actors this often (ms) */
const PROBE_MS = 500;
/** opacity of the player model while it hides an adjacent actor */
export const PLAYER_SEE_THROUGH = 0.35;
const LUNGE_MS = 170;
const MAX_BLOCKING_MS = 520;
const SAFETY_MS = 1200;

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly gl: THREE.WebGLRenderer;
  readonly rig: CameraRig;
  readonly lights = new LightRig();
  readonly anim = new Animator();
  readonly vfx: VfxLayer;
  readonly backdrop = new Backdrop();
  private reduceMotion = false;

  private container: HTMLElement;
  private world: WorldSpec | null = null;
  private area: AreaView | null = null;
  private areaIndex = -1;
  private actors: ActorLayer | null = null;
  private items: ItemLayer | null = null;
  private state: GameState | null = null;
  private highlight: THREE.InstancedMesh | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private disposed = false;
  private resizeObs: ResizeObserver | null = null;
  private cutKey = '';
  private focus = new THREE.Vector3();
  private playerId: string | null = null;
  private modelLightReqs: ModelLightRequest[] = [];
  private raycaster = new THREE.Raycaster();
  private syncGen = 0;
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private qualitySetting: QualitySetting = 'auto';
  private profile: QualityProfile = QUALITY_PROFILES.high;
  private thumbnailer: ItemThumbnailer | null = null;
  /** overlay panels over the canvas (viewport CSS px) that auto framing keeps actors out of */
  private overlayRects: OverlayRect[] = [];
  /**
   * Find the page's panels over the map by themselves: once the camera rests, each framed actor's feet
   * and head are hit-tested (document.elementFromPoint); a panel found over one is measured from then
   * on (until it leaves the page) and framing moves the actor out from under it. Elements inside the
   * renderer's container (map labels) never count.
   */
  autoOverlays = true;
  private autoOverlayEls = new Set<Element>();
  /** hit-test framed actors against the page once the camera rests */
  private probeDue = false;
  /** when probeOverlays last ran (ms, frame clock); it re-runs every PROBE_MS while the camera rests */
  private lastProbe = 0;
  /** the found panels' rects the camera rig was last given (rounded), to notice them move or go */
  private autoKey = '';
  /** re-check whether the player model hides a neighbour once the camera rests */
  private seeThroughDue = false;
  /** the player model is drawn see-through because it hides an adjacent actor */
  private playerSeeThrough = false;
  /** the player is drawn ghosted (sneaking / invisible) */
  private playerGhosted = false;
  private readonly mobile: boolean;
  private adaptive: AdaptiveQuality | null = null;
  private fpsMeter = new FpsMeter();
  private maxPixelRatio: number;
  private shadowsOpt: boolean;
  private lastStats = { drawCalls: 0, triangles: 0 };
  private contextLost = false;
  private onLost = (e: Event) => {
    e.preventDefault(); // lets the browser restore the context later
    this.contextLost = true;
    this.anim.finishAll();
    this.onContextChange?.(true);
  };
  private onRestored = () => {
    this.contextLost = false;
    this.rebuild();
    this.onContextChange?.(false);
  };
  /** called when the WebGL context is lost (true) and after it was restored and the scene rebuilt (false) */
  onContextChange: ((lost: boolean) => void) | null = null;

  constructor(container: HTMLElement, opts: RendererOptions = {}) {
    this.container = container;
    this.gl = new THREE.WebGLRenderer({ antialias: opts.antialias ?? true, powerPreference: 'high-performance' });
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;
    this.shadowsOpt = opts.shadows ?? true;
    this.mobile = isMobileDevice(opts.device ?? browserDeviceHints());
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NeutralToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = opts.shadows ?? true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    const canvas = this.gl.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);

    this.rig = new CameraRig(1);
    this.vfx = new VfxLayer(this.anim);
    this.scene.add(this.lights.group, this.vfx.group, this.backdrop.mesh);
    this.scene.background = new THREE.Color('#101014');
    this.setReduceMotion(opts.reduceMotion ?? prefersReducedMotion());
    this.setQuality(opts.quality ?? 'auto');

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(container);
    }
    this.last = performance.now();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------------
  // World & area
  // ---------------------------------------------------------------------------

  setWorld(world: WorldSpec): void {
    if (this.world === world) return;
    this.world = world;
    this.thumbnailer?.setWorld(world);
    this.clearArea();
    this.actors?.dispose();
    this.items?.dispose();
    if (this.actors) this.scene.remove(this.actors.group);
    if (this.items) this.scene.remove(this.items.group);
    this.actors = new ActorLayer(world);
    this.items = new ItemLayer(world);
    this.scene.add(this.actors.group, this.items.group);
    this.areaIndex = -1;
  }

  setArea(area: FoggedArea, world?: WorldSpec): void {
    if (world) this.setWorld(world);
    const w = this.world;
    if (!w) throw new Error('Renderer.setArea: call setWorld first (or pass the world)');
    const plan: AreaPlan | undefined = w.areas[area.index] ?? w.areas[w.areas.length - 1];
    this.clearArea();
    this.anim.finishAll();
    this.vfx.clear();
    for (const id of [...(this.actors?.views.keys() ?? [])]) this.actors!.remove(id);
    for (const id of [...(this.items?.views.keys() ?? [])]) this.items!.removeView(id);
    this.area = new AreaView(w, plan, area);
    this.scene.add(this.area.group);
    this.areaIndex = area.index;
    this.lights.configure(plan.lighting, this.scene);
    const bg = this.backdrop.configure(plan.backdrop);
    if (bg) {
      this.lights.background = col(bg);
      this.scene.background = this.lights.background;
    }
    this.area.reduceMotion = this.reduceMotion;
    this.lights.setSightRadius(0);
    this.actors?.setLightFloor(this.lights.actorLightFloor);
    if (this.actors) this.actors.groundColor = plan.floor?.color;
    this.rig.setFrameDist(0);
    this.rig.setPan({ x: 0, y: 0 });
    this.playerSeeThrough = false;
    this.cutKey = '';
    // snap the camera onto the player (or the map start) so the area doesn't swoop in
    const player = area.actors.find((a) => a.faction === 'player' || a.defId === 'player');
    const p = player?.pos ?? area.map.start;
    this.focus.set(p.x, 0, p.y);
    this.rig.follow(this.focus, true);
    this.rig.settle();
    this.area.setFocus(p, this.rig.yawStep, true);
  }

  /** Freeze (true) or resume cosmetic motion: backdrop animation and liquid ripples. */
  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    this.backdrop.reduceMotion = on;
    if (this.area) this.area.reduceMotion = on;
  }

  /** The current area's backdrop parameters (null = plain background colour); for tests/dev pages. */
  /** remembered wall / outline / floor luminance of the current area (see AreaView.rememberedContrast); for tests */
  rememberedWallContrast(): ReturnType<AreaView['rememberedContrast']> {
    return this.area?.rememberedContrast() ?? null;
  }

  /** liquid terrain patches of the current area; for tests */
  liquidTerrainInfo(): ReturnType<AreaView['liquidTerrainInfo']> {
    return this.area?.liquidTerrainInfo() ?? [];
  }

  /**
   * A small picture (PNG data URL, THUMB_SIZE px square, transparent background) of item `defId`'s
   * model, rendered once per world into a shared offscreen target and cached. null for def ids the
   * world does not have, before setWorld, or while the WebGL context is lost. It shows the item as it
   * really is: the UI shows it only for items the player has identified.
   */
  itemThumbnail(defId: string): string | null {
    if (!this.world || this.disposed) return null;
    this.thumbnailer ??= new ItemThumbnailer(this.gl);
    return this.thumbnailer.get(this.world, defId);
  }

  get backdropInfo(): { style: string; color: string; color2: string; intensity: number } | null {
    const p = this.backdrop.params;
    return p ? { style: p.style, color: p.color, color2: p.color2, intensity: p.intensity } : null;
  }

  private clearArea(): void {
    if (this.area) {
      this.scene.remove(this.area.group);
      this.area.dispose();
      this.area = null;
    }
    this.highlightTiles([]);
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async sync(state: GameState, events: GameEvent[] = []): Promise<void> {
    if (!this.world || !this.actors || !this.items) throw new Error('Renderer.sync: call setWorld first');
    // a new turn fast-forwards whatever the previous one was still doing
    this.anim.finishBlocking();
    const gen = ++this.syncGen;
    const fogged = { ...state.area, seen: leadPlayer(state).seen };
    if (!this.area || state.area.index !== this.areaIndex) this.setArea(fogged);
    else if (!this.area.updateTiles(state.area.map)) this.setArea(fogged);
    const area = this.area!;
    this.state = state;
    this.playerId = leadPlayer(state).actorId;
    area.applySeen(leadPlayer(state).seen);

    const actors = this.actors;
    const byId = new Map<string, ActorInstance>(state.area.actors.map((a) => [a.id, a]));
    const visibleAt = (p: Pos) => area.isVisible(p.x, p.y);
    const isPlayer = (id: string) => id === this.playerId;

    // an actor whose definition changed (transform) gets a fresh model, popping in
    const transformed = new Set<string>();
    for (const a of state.area.actors) {
      const v = actors.views.get(a.id);
      if (v && v.defId !== a.defId) {
        actors.remove(a.id);
        transformed.add(a.id);
      }
    }
    // make sure every actor referenced by an event (or present in state) has a view
    for (const a of state.area.actors) {
      if (!actors.views.has(a.id)) {
        const v = actors.ensure(a, isPlayer(a.id));
        // actors new to the renderer appear where their first move starts
        const mv = events.find((e) => e.type === 'moved' && e.actorId === a.id) as Extract<GameEvent, { type: 'moved' }> | undefined;
        if (mv) {
          v.root.position.set(mv.from.x, 0, mv.from.y);
          v.tile = { ...mv.from };
        }
      }
    }

    const busy = new Map<string, number>(); // per-actor time its current animation ends
    let cursor = 0; // global stagger cursor for attacks/effects
    const impactAt = new Map<string, number>();
    let lastImpact = 0;
    const damagedIds = new Set(events.filter((e) => e.type === 'damaged').map((e) => (e as { actorId: string }).actorId));
    const statusCount = new Map<string, number>();
    const textCount = new Map<string, number>();
    // stack several numbers on one actor instead of drawing them on top of each other
    const say = (v: ActorView, text: string, color: string, at: number, opts: { size?: number; rise?: number; duration?: number; lift?: number } = {}) => {
      const k = textCount.get(v.id) ?? 0;
      textCount.set(v.id, k + 1);
      this.vfx.text(headPos(v).add(new THREE.Vector3(0, k * 0.3 + (opts.lift ?? 0), 0)), text, color, at + k * 90, { ...opts, follow: v.root });
    };
    const moved = new Set<string>();
    const dying = new Set<string>();
    const headPos = (v: ActorView) => new THREE.Vector3(v.tile.x, Math.min(2.4, v.height) + 0.25, v.tile.y);
    const chestPos = (v: ActorView) => new THREE.Vector3(v.tile.x, Math.min(1.2, v.height * 0.6), v.tile.y);
    const at3 = (p: Pos, y = 0.5) => new THREE.Vector3(p.x, y, p.y);
    const dmgColor = (dt: string) => this.world!.damageTypes.find((d) => d.id === dt)?.color ?? '#ff6b5a';

    for (const ev of events) {
      switch (ev.type) {
        case 'moved': {
          const v = actors.views.get(ev.actorId);
          if (!v) break;
          const start = busy.get(v.id) ?? 0;
          const from = new THREE.Vector3(ev.from.x, 0, ev.from.y);
          const to = new THREE.Vector3(ev.to.x, 0, ev.to.y);
          v.tile = { ...ev.to };
          moved.add(v.id);
          const face = facingAngle(ev.from, ev.to);
          const show = v.isPlayer || visibleAt(ev.from) || visibleAt(ev.to);
          const jump = Math.abs(ev.from.x - ev.to.x) > 1 || Math.abs(ev.from.y - ev.to.y) > 1;
          this.anim.add({
            delay: start,
            duration: jump ? 60 : MOVE_MS,
            ease: ease.inOutQuad,
            start: () => {
              v.root.visible = show;
              if (face !== null) v.root.rotation.y = face;
            },
            update: (k) => {
              v.root.position.lerpVectors(from, to, k);
              v.motion.walk = k < 1 ? k : 0;
            },
            done: () => {
              v.motion.walk = 0;
            },
          });
          busy.set(v.id, start + (jump ? 60 : MOVE_MS));
          if (jump) this.vfx.sparkle(to, 0.5, '#ffffff', start);
          break;
        }
        case 'attacked': {
          const a = actors.views.get(ev.attackerId);
          const t = actors.views.get(ev.targetId);
          if (!a || !t) break;
          const start = Math.max(cursor, busy.get(a.id) ?? 0);
          const face = facingAngle(a.tile, t.tile);
          const dir = new THREE.Vector3(t.tile.x - a.tile.x, 0, t.tile.y - a.tile.y);
          if (dir.lengthSq() > 0) dir.normalize();
          const color = dmgColor(ev.damageType);
          let impact: number;
          if (ev.ranged) {
            this.anim.add({
              delay: start,
              duration: 120,
              start: () => face !== null && (a.root.rotation.y = face),
              update: (k) => {
                a.inner.position.copy(dir).multiplyScalar(-0.08 * Math.sin(k * Math.PI));
                a.motion.swing = k < 1 ? k : 0;
              },
            });
            const fly = this.vfx.bolt(chestPos(a), chestPos(t), color, start + 40);
            impact = start + 40 + fly;
          } else {
            this.anim.add({
              delay: start,
              duration: LUNGE_MS,
              start: () => face !== null && (a.root.rotation.y = face),
              update: (k) => {
                a.inner.position.copy(dir).multiplyScalar(0.36 * Math.sin(k * Math.PI));
                a.motion.swing = k < 1 ? k : 0;
              },
            });
            impact = start + LUNGE_MS * 0.5;
            if (ev.hit) this.vfx.slash(at3(t.tile), at3(a.tile), color, impact - 30);
          }
          busy.set(a.id, start + (ev.ranged ? 120 : LUNGE_MS));
          cursor = start + 110;
          impactAt.set(t.id, impact);
          lastImpact = impact;
          if (!ev.hit) {
            say(t, missLabel(), '#d8d8e0', impact, { size: 0.75 });
          } else {
            if (!damagedIds.has(t.id) && ev.damage > 0) say(t, `${ev.damage}`, color, impact);
            this.knockback(t, dir, impact);
          }
          break;
        }
        case 'damaged': {
          const v = actors.views.get(ev.actorId);
          if (!v) break;
          const t = impactAt.get(v.id) ?? Math.max(lastImpact, cursor);
          say(v, `${ev.amount}`, dmgColor(ev.damageType), t, { size: ev.amount >= 10 ? 1.2 : 1 });
          if (!impactAt.has(v.id)) this.knockback(v, null, t);
          break;
        }
        case 'healed': {
          const v = actors.views.get(ev.actorId);
          if (!v || ev.amount <= 0) break;
          const t = Math.max(lastImpact, cursor);
          say(v, `+${ev.amount}`, '#6ff59a', t);
          this.vfx.sparkle(at3(v.tile, 0), 0.45, '#6ff59a', t);
          break;
        }
        case 'status_applied': {
          const v = actors.views.get(ev.actorId);
          if (!v) break;
          const def = this.world.statuses.find((s) => s.id === ev.status);
          const n = statusCount.get(v.id) ?? 0;
          statusCount.set(v.id, n + 1);
          const t = Math.max(lastImpact, cursor) + 120 + n * 200;
          say(v, def?.name ?? ev.status, def?.color ?? '#e0d0ff', t, { size: 0.7, rise: 0.5, duration: 1200, lift: 0.15 });
          this.vfx.ring(at3(v.tile, 0), 0.2, def?.color ?? '#e0d0ff', t, 0.6);
          break;
        }
        case 'died': {
          const v = actors.views.get(ev.actorId);
          if (!v) break;
          dying.add(v.id);
          v.dying = true;
          const t = (impactAt.get(v.id) ?? Math.max(lastImpact, cursor)) + 90;
          const killer = ev.killerId ? actors.views.get(ev.killerId) : undefined;
          const away = killer ? Math.atan2(v.tile.x - killer.tile.x, v.tile.y - killer.tile.y) : v.root.rotation.y;
          this.anim.add({
            delay: t,
            duration: 520,
            blocking: false,
            ease: ease.inOutQuad,
            start: () => {
              v.root.rotation.y = away;
              v.hp.group.visible = false;
            },
            update: (k) => {
              v.inner.rotation.x = Math.min(1, k * 1.6) * (Math.PI / 2) * 0.92;
              v.inner.position.y = -k * 0.12;
              this.actors?.setOpacity(v, 1 - Math.max(0, (k - 0.35) / 0.65));
            },
            done: () => this.actors?.remove(v.id),
          });
          break;
        }
        case 'effect': {
          const kind = ev.vfx || 'burst';
          const color = ev.color ?? this.world.palette.accent;
          const start = cursor;
          const from = at3(ev.from, 0.55);
          const to = at3(ev.to, kind === 'ring' || kind === 'cloud' || kind === 'sparkle' ? 0 : 0.55);
          const wait = this.vfx.effect(kind, from, to, color, ev.radius ?? 0, start);
          lastImpact = start + wait;
          cursor = start + Math.min(wait, 180);
          break;
        }
        case 'item_picked': {
          const iv = this.items.views.get(ev.itemId);
          const pv = this.playerId ? actors.views.get(this.playerId) : undefined;
          if (!iv) break;
          iv.leaving = true;
          const from = iv.root.position.clone();
          const target = pv ? new THREE.Vector3(pv.tile.x, 0.5, pv.tile.y) : from.clone().add(new THREE.Vector3(0, 1, 0));
          this.anim.add({
            delay: busy.get(this.playerId ?? '') ?? 0,
            duration: 280,
            blocking: false,
            ease: ease.inOutQuad,
            update: (k) => {
              iv.root.position.lerpVectors(from, target, k);
              iv.root.position.y = from.y + Math.sin(k * Math.PI) * 0.6 + k * 0.4;
              iv.root.scale.setScalar(1 - k * 0.8);
            },
            done: () => this.items?.removeView(iv.id),
          });
          this.vfx.sparkle(target.clone().setY(0), 0.35, '#fff3b0', 200);
          break;
        }
        case 'spawned': {
          const v = actors.views.get(ev.actorId);
          if (!v) break;
          const t = cursor;
          v.inner.scale.setScalar(0.001);
          this.anim.add({
            delay: t,
            duration: 260,
            blocking: false,
            ease: ease.outBack,
            update: (k) => v.inner.scale.setScalar(Math.max(0.001, k)),
          });
          this.vfx.ring(at3(v.tile, 0), 0.3, this.world.palette.accent, t);
          break;
        }
        case 'noise':
          this.vfx.ring(at3(ev.pos, 0), ev.radius, '#bfc6d4', cursor, 0.35);
          break;
        case 'level_up': {
          const pv = this.playerId ? actors.views.get(this.playerId) : undefined;
          if (!pv) break;
          this.vfx.ring(at3(pv.tile, 0), 1.2, '#ffe27a', cursor);
          this.vfx.sparkle(at3(pv.tile, 0), 0.7, '#ffe27a', cursor + 80);
          break;
        }
        case 'low_hp': {
          const pv = this.playerId ? actors.views.get(this.playerId) : undefined;
          if (pv) this.vfx.ring(at3(pv.tile, 0), 0.6, '#ff4a4a', cursor + 150, 0.7);
          break;
        }
        case 'terrain_changed':
          for (const p of ev.positions.slice(0, 12)) this.vfx.burst(at3(p, 0.2), 0.3, this.world.palette.accent, cursor, false);
          break;
        default:
          break;
      }
    }

    for (const id of transformed) {
      const v = actors.views.get(id);
      if (!v) continue;
      v.inner.scale.setScalar(0.001);
      this.anim.add({ delay: cursor, duration: 300, blocking: false, ease: ease.outBack, update: (k) => v.inner.scale.setScalar(Math.max(0.001, k)) });
      this.vfx.sparkle(at3(v.tile, 0), 0.6, this.world.palette.accent, cursor);
    }

    // reconcile actor views with the authoritative state
    for (const a of state.area.actors) {
      const v = actors.views.get(a.id)!;
      if (v.dying && !dying.has(a.id)) {
        // came back (revived / transformed): reset
        v.dying = false;
        v.inner.rotation.x = 0;
        v.inner.position.set(0, 0, 0);
        actors.setOpacity(v, 1);
      }
      actors.setFaction(v, ActorLayer.factionOf(a, isPlayer(a.id)));
      // sneaking player / invisible actors are drawn ghosted
      const ghosted = (v.isPlayer && leadPlayer(state).sneaking) || a.statuses.some((st) => this.world!.statuses.find((d) => d.id === st.id)?.flags.includes('invisible'));
      if (v.isPlayer) this.playerGhosted = ghosted;
      const want = this.restingOpacity(v, ghosted);
      if (!v.dying && v.opacity !== want && (want !== 1 || v.fadeMats)) actors.setOpacity(v, want);
      const frac = a.maxHp > 0 ? a.hp / a.maxHp : 1;
      const hpTime = impactAt.get(a.id) ?? 0;
      const showBar = frac < 0.999 && a.hp > 0;
      if (hpTime > 0) this.anim.add({ delay: hpTime, duration: 1, blocking: false, update: () => this.applyHp(v, frac, showBar) });
      else this.applyHp(v, frac, showBar);
      const shown = v.isPlayer || visibleAt(a.pos);
      if (!moved.has(a.id) && (v.tile.x !== a.pos.x || v.tile.y !== a.pos.y)) {
        // teleports, pushes, pulls without a 'moved' event: quick slide or snap
        const from = v.root.position.clone();
        const to = new THREE.Vector3(a.pos.x, 0, a.pos.y);
        const far = from.distanceTo(to) > 2.5;
        v.tile = { ...a.pos };
        if (far) {
          v.root.position.copy(to);
          this.vfx.sparkle(to, 0.5, '#ffffff', cursor);
        } else this.anim.add({ delay: cursor, duration: 140, ease: ease.outCubic, update: (k) => v.root.position.lerpVectors(from, to, k) });
      }
      if (moved.has(a.id)) {
        // visibility at the end of the move
        this.anim.add({ delay: busy.get(a.id) ?? 0, duration: 1, update: () => {}, done: () => (v.root.visible = v.isPlayer || area.isVisible(v.tile.x, v.tile.y)) });
      } else v.root.visible = shown;
      v.tile = { ...a.pos };
    }
    for (const [id, v] of actors.views) {
      if (byId.has(id)) continue;
      if (dying.has(id) || v.dying) {
        v.root.visible = v.root.visible || visibleAt(v.tile);
        continue;
      }
      // vanished without a death event (left the area, transformed…): quick fade
      v.dying = true;
      this.anim.add({ duration: 200, blocking: false, update: (k) => this.actors?.setOpacity(v, 1 - k), done: () => this.actors?.remove(id) });
    }

    // floor items
    const leaving = new Set<string>();
    for (const [id, iv] of this.items.views) if (iv.leaving) leaving.add(id);
    this.items.reconcile(state.area.items, state, (x, y) => area.isVisible(x, y), leaving);

    // keep the whole turn short: compress if the timeline ran long
    const lastEnd = Math.max(0, ...busy.values(), cursor, lastImpact);
    if (lastEnd > MAX_BLOCKING_MS) {
      // too many things happened at once; let the tail finish quickly by fast-forwarding later
      setTimeout(() => {
        if (gen === this.syncGen) this.anim.finishBlocking();
      }, MAX_BLOCKING_MS);
    }

    // camera target follows the player's logical tile
    const pa = this.playerId ? byId.get(this.playerId) : undefined;
    if (pa) {
      // light and fog follow the engine's sight, and the camera keeps every visible actor framed, so
      // nothing the engine lets the player see (and that can act on them) is dark or off screen
      this.lights.setSightRadius(visibleRadius({ map: state.area.map, seen: leadPlayer(state).seen }, pa.pos));
      this.focus.set(pa.pos.x, 0, pa.pos.y);
      this.rig.follow(this.focus);
      this.reframe(state, pa);
      this.updateCutaway(pa.pos);
    }
    this.probeDue = true;
    this.seeThroughDue = true;

    if (!this.anim.busy) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.anim.finishBlocking();
        resolve();
      }, SAFETY_MS);
      void this.anim.whenIdle().then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private applyHp(v: ActorView, frac: number, show: boolean): void {
    v.hp.set(frac);
    v.hp.group.visible = show && !v.dying;
  }

  private knockback(v: ActorView, dir: THREE.Vector3 | null, at: number): void {
    const d = dir && dir.lengthSq() > 0 ? dir.clone() : new THREE.Vector3(0, 0, 0);
    this.anim.add({
      delay: at,
      duration: 160,
      blocking: false,
      update: (k) => {
        if (v.dying) return;
        const s = Math.sin(k * Math.PI);
        v.inner.position.set(d.x * 0.12 * s + Math.sin(k * 40) * 0.025 * (1 - k), 0, d.z * 0.12 * s);
        v.inner.scale.set(1 + 0.08 * s, 1 - 0.1 * s, 1 + 0.08 * s);
      },
      done: () => {
        if (v.dying) return;
        v.inner.position.set(0, 0, 0);
        v.inner.scale.set(1, 1, 1);
      },
    });
  }

  /**
   * Zoom out (never in) as far as needed to keep every non-player actor on a visible tile on screen;
   * the player's own zoom choice wins when it is wider.
   */
  private reframe(state: GameState, player: ActorInstance): void {
    // panels found on the page move, resize and go away (toasts): measure them again each time
    if (this.autoOverlayEls.size) this.applyOccluders();
    const pts = this.framedPoints(state, player.id);
    if (!pts.length) {
      this.rig.setFrameDist(0);
      this.rig.setPan({ x: 0, y: 0 });
      return;
    }
    const pv = this.actors?.views.get(player.id);
    const ph = Math.min(2.4, pv?.height ?? 1.2);
    const me = [new THREE.Vector3(player.pos.x, 0, player.pos.y), new THREE.Vector3(player.pos.x, ph, player.pos.y)];
    const f = this.rig.frame(pts, this.rig.userDist, { player: me });
    this.rig.setFrameDist(f.dist);
    this.rig.setPan(f.pan);
  }

  /** feet and head of every living non-player actor on a visible tile (what auto framing keeps clear) */
  private framedPoints(state: GameState, playerId: string): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (const a of state.area.actors) {
      if (a.id === playerId || a.hp <= 0) continue;
      if (!this.area?.isVisible(a.pos.x, a.pos.y)) continue;
      const v = this.actors?.views.get(a.id);
      const h = Math.min(2.4, v?.height ?? 1.2);
      pts.push(new THREE.Vector3(a.pos.x, 0, a.pos.y), new THREE.Vector3(a.pos.x, h, a.pos.y));
    }
    return pts;
  }

  /** the player's state, re-framed (after the overlay panels changed) */
  private reframeNow(): void {
    if (!this.state || !this.playerId) return;
    const pa = this.state.area.actors.find((a) => a.id === this.playerId);
    if (pa) this.reframe(this.state, pa);
  }

  /**
   * Hit-test where each framed actor is drawn (feet, middle, head) against the page: a panel over one
   * becomes an overlay rect (see autoOverlays) and the view is re-framed. Returns true when it found a
   * new panel. Called once the camera rests; public for tests.
   */
  probeOverlays(): boolean {
    if (!this.autoOverlays || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
    if (!this.state || !this.playerId || !this.actors) return false;
    const canvas = this.gl.domElement;
    if (!canvas.isConnected) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const me = this.actors.views.get(this.playerId);
    const centre = me ? this.projectToViewport(me.root.position, rect) : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const vw = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : rect.width;
    const vh = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : rect.height;
    // panels found earlier move, resize and leave (a dismissed narration, a toast): measure them again
    let found = this.autoRectsKey() !== this.autoKey;
    for (const v of this.actors.views.values()) {
      if (v.isPlayer || v.dying || !v.root.visible) continue;
      if (!this.area?.isVisible(v.tile.x, v.tile.y)) continue;
      const h = Math.min(2.4, v.height);
      for (const frac of [0, 0.45, 1]) {
        const p = v.root.position.clone();
        p.y += h * frac;
        const s = this.projectToViewport(p, rect);
        if (s.x < rect.left || s.y < rect.top || s.x > rect.right || s.y > rect.bottom || s.x >= vw || s.y >= vh || s.x < 0 || s.y < 0) continue;
        const hit = document.elementFromPoint(s.x, s.y);
        if (!hit || hit === canvas || this.container.contains(hit)) continue;
        const panel = overlayPanel(hit, this.container, centre, vw * vh);
        if (!panel || this.autoOverlayEls.has(panel)) continue;
        this.autoOverlayEls.add(panel);
        found = true;
      }
    }
    if (found) {
      this.applyOccluders();
      this.cutKey = '';
      this.reframeNow();
    }
    return found;
  }

  /** panels found by probeOverlays (viewport CSS px, measured now); for tests */
  get autoOverlayRects(): OverlayRect[] {
    return this.measureAutoOverlays();
  }

  /** forget the panels found by probeOverlays (they are found again when they cover an actor) */
  clearAutoOverlays(): void {
    this.autoOverlayEls.clear();
    this.applyOccluders();
    this.reframeNow();
  }

  private measureAutoOverlays(): OverlayRect[] {
    const out: OverlayRect[] = [];
    for (const el of Array.from(this.autoOverlayEls)) {
      if (!el.isConnected) {
        this.autoOverlayEls.delete(el);
        continue;
      }
      let hidden = false;
      try {
        const cs = getComputedStyle(el);
        hidden = cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
      } catch {
        /* not an element we can style-check */
      }
      if (hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return out;
  }

  private autoRectsKey(): string {
    return rectsKey(this.measureAutoOverlays());
  }

  private projectToViewport(p: THREE.Vector3, rect: DOMRect): { x: number; y: number } {
    const v = p.clone().project(this.rig.camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** the opacity a view rests at: ghosted 0.5; the player see-through while it hides a neighbour */
  private restingOpacity(v: ActorView, ghosted: boolean): number {
    const base = ghosted ? 0.5 : 1;
    return v.isPlayer && this.playerSeeThrough ? Math.min(base, PLAYER_SEE_THROUGH) : base;
  }

  /**
   * true when the player's model hides most of a living actor on an adjacent visible tile from the
   * camera (a short creature right behind a tall player): rays from the camera to the actor's body
   * hit the player's model first.
   */
  playerHidesNeighbour(): boolean {
    if (!this.actors || !this.playerId || !this.area) return false;
    const me = this.actors.views.get(this.playerId);
    if (!me || !me.root.visible) return false;
    const cam = this.rig.camera;
    const ray = new THREE.Raycaster();
    const dir = new THREE.Vector3();
    for (const v of this.actors.views.values()) {
      if (v.isPlayer || v.dying || !v.root.visible) continue;
      if (Math.max(Math.abs(v.tile.x - me.tile.x), Math.abs(v.tile.y - me.tile.y)) !== 1) continue;
      if (!this.area.isVisible(v.tile.x, v.tile.y)) continue;
      const h = Math.min(2.4, v.height);
      let blocked = 0;
      const fracs = [0.25, 0.55, 0.85];
      for (const f of fracs) {
        const target = v.root.position.clone();
        target.y += h * f;
        dir.copy(target).sub(cam.position);
        const len = dir.length();
        ray.set(cam.position, dir.normalize());
        ray.far = len;
        const hits = ray.intersectObject(me.inner, true).filter((x) => x.object.visible && (x.object as THREE.Mesh).isMesh && !x.object.userData.outline);
        if (hits.length) blocked++;
      }
      if (blocked >= 2) return true;
    }
    return false;
  }

  /** draw the player see-through while it hides a neighbour (see playerHidesNeighbour) */
  private updateSeeThrough(): void {
    const on = this.playerHidesNeighbour();
    if (on === this.playerSeeThrough) return;
    this.playerSeeThrough = on;
    const v = this.playerId ? this.actors?.views.get(this.playerId) : undefined;
    if (!v || v.dying) return;
    const want = this.restingOpacity(v, this.playerGhosted);
    if (v.opacity !== want) this.actors?.setOpacity(v, want);
  }

  /** the player model is drawn see-through right now (it hides an adjacent actor); for tests */
  get playerIsSeeThrough(): boolean {
    return this.playerSeeThrough;
  }

  private updateCutaway(p: Pos): void {
    if (!this.area) return;
    this.area.setFocus(p, this.rig.yawStep);
    // actors standing next to the player (the ones being fought or talked to) get a wedge cleared;
    // every other actor the engine reports as visible has the walls on its line to the camera
    // lowered (the engine's line of sight is top-down, the camera's is not)
    const focus: Pos[] = [];
    const far: { tile: Pos; height: number }[] = [];
    for (const v of this.actors?.views.values() ?? []) {
      if (v.isPlayer || v.dying || !v.root.visible) continue;
      if (!this.area.isVisible(v.tile.x, v.tile.y)) continue;
      if (Math.max(Math.abs(v.tile.x - p.x), Math.abs(v.tile.y - p.y)) <= 1) focus.push(v.tile);
      far.push({ tile: v.tile, height: Math.min(2.4, v.height) });
    }
    const eye = this.rig.restingPosition();
    focus.sort((a, b) => a.y - b.y || a.x - b.x);
    far.sort((a, b) => a.tile.y - b.tile.y || a.tile.x - b.tile.x);
    const key = `${p.x},${p.y},${this.rig.yawStep}|${focus.map((f) => `${f.x},${f.y}`).join(';')}|${far.map((f) => `${f.tile.x},${f.tile.y}`).join(';')}|${eye.toArray().map((n) => Math.round(n * 2)).join(',')}`;
    if (key === this.cutKey) return;
    this.cutKey = key;
    const area = this.area;
    // a wall of height H at depth d hides the ground up to H/tan(pitch) behind it; keep the player's
    // tile and its neighbours clear
    const shadowLen = area.wallHeight / Math.tan(this.rig.pitch);
    const set = cutawayTiles({ width: area.width, height: area.height, isTall: (i) => area.isTall(i) }, p, this.rig.yawStep, {
      depth: Math.max(2, Math.min(5, Math.ceil(1.4 + shadowLen))),
      halfWidth: 2,
      spread: 0.6,
      around: 0.5,
      focus,
    });
    const cut = { width: area.width, height: area.height, isTall: (i: number) => area.isTall(i) };
    // tall terrain can stand a little above the walls; err on the side of lowering
    const tallHeight = area.wallHeight + 0.3;
    for (const f of far) occluderTiles(cut, f.tile, eye, { height: f.height, tallHeight }, set);
    area.setCutaway(set);
  }

  skipAnimations(): void {
    this.anim.finishAll();
  }

  // ---------------------------------------------------------------------------
  // Camera & input helpers
  // ---------------------------------------------------------------------------

  rotateCamera(dir: -1 | 1): void {
    this.rig.rotate(dir);
    const p = this.playerTile();
    if (p) this.updateCutaway(p);
    // another side of the actors faces the panels and the player now: frame and test again
    this.reframeNow();
    this.probeDue = true;
    this.seeThroughDue = true;
  }

  zoom(delta: number): void {
    this.rig.zoom(delta);
  }

  /** Pinch zoom: f > 1 brings the camera closer (fingers spreading), f < 1 moves it away. */
  zoomBy(f: number): void {
    this.rig.zoomBy(f);
  }

  /** One animated 90° camera step (touch rotate button / two-finger twist). */
  rotateStep(dir: -1 | 1): void {
    this.rotateCamera(dir);
  }

  /**
   * CSS px of the canvas covered by overlay UI (HUD on top, hotbar at the bottom, safe-area insets).
   * The player is kept centred in the uncovered part and default zoom / auto framing only count it.
   */
  setViewportInsets(insets: Partial<ViewInsets>): void {
    this.rig.setInsets(insets);
    this.cutKey = '';
    this.applyOccluders();
    this.reframeNow();
    this.probeDue = true;
    this.seeThroughDue = true;
  }

  /**
   * Overlay panels drawn over the canvas (viewport CSS px, e.g. getBoundingClientRect() of the HUD,
   * log, hotbar + context buttons, goal bar). Unlike setViewportInsets they do not move the view
   * centre; auto framing zooms out until no visible actor stands under one of them. A rect that
   * covers the view centre (where the player stands) is ignored. [] clears.
   */
  setOverlayRects(rects: readonly OverlayRect[]): void {
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    this.overlayRects = rects
      .filter((r) => r && ok(r.left) && ok(r.top) && ok(r.right) && ok(r.bottom) && r.right > r.left && r.bottom > r.top)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    this.applyOccluders();
    this.cutKey = '';
    this.reframeNow();
    this.probeDue = true;
  }

  get overlayRectsInUse(): OverlayRect[] {
    return this.overlayRects.map((r) => ({ ...r }));
  }

  /** overlay rects → canvas-relative px for the camera rig */
  private applyOccluders(): void {
    let ox = 0;
    let oy = 0;
    try {
      const rc = this.gl.domElement.getBoundingClientRect();
      ox = rc.left;
      oy = rc.top;
    } catch {
      /* detached canvas */
    }
    const auto = this.measureAutoOverlays();
    this.autoKey = rectsKey(auto);
    const all = [...this.overlayRects, ...auto];
    this.rig.setOccluders(all.map((r) => ({ left: r.left - ox, top: r.top - oy, right: r.right - ox, bottom: r.bottom - oy })));
  }

  get viewportInsets(): ViewInsets {
    return { ...this.rig.insets };
  }

  /**
   * Tile under viewport coordinates (a tap / click). A hit on a visible non-player actor's model gives
   * the tile it stands on (tall models cover the tiles behind them); otherwise the ground under the
   * point. The player's own model never claims a tap whose ground point is another tile.
   */
  pick(x: number, y: number): Pos | null {
    if (!this.area) return null;
    const ndc = this.toNdc(x, y);
    if (!ndc) return null;
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    if (this.actors) {
      const roots: THREE.Object3D[] = [];
      const byRoot = new Map<THREE.Object3D, ActorView>();
      for (const v of this.actors.views.values()) {
        if (!v.root.visible || v.dying) continue;
        roots.push(v.inner);
        byRoot.set(v.inner, v);
      }
      if (roots.length) {
        let mine: Pos | null = null;
        for (const hit of this.raycaster.intersectObjects(roots, true)) {
          if (!hit.object.visible || !(hit.object as THREE.Mesh).isMesh) continue;
          let o: THREE.Object3D | null = hit.object;
          while (o && !byRoot.has(o)) o = o.parent;
          const v = o ? byRoot.get(o) : undefined;
          if (!v || !inBounds(v.tile, this.area.width, this.area.height)) continue;
          // the player's own model is never the answer while another actor is behind it on the same
          // ray: a tall player model would otherwise swallow every tap on a short creature at its back
          if (v.isPlayer) {
            mine ??= { ...v.tile };
            continue;
          }
          return { ...v.tile };
        }
        if (mine) {
          // nothing else along the ray: a tall player model covers the tiles drawn behind it, and a tap
          // there means that tile (walk there, or the actor the model hides; only an antenna shows), not
          // "my own tile", which does nothing. Only a point whose ground is the player's tile picks it.
          return this.screenToTile(x, y) ?? mine;
        }
      }
    }
    return this.screenToTile(x, y);
  }

  private toNdc(x: number, y: number): THREE.Vector2 | null {
    const rect = this.gl.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  }

  // ---------------------------------------------------------------------------
  // Quality & stats
  // ---------------------------------------------------------------------------

  /**
   * 'high': full pixel ratio (≤ 2), sun shadows, all lights, detailed backdrop. 'low': pixel ratio
   * ≤ 1.5, no shadows, fewer lights, cheaper backdrop. 'auto' starts low on phones / touch devices and
   * high elsewhere, then drops to low when frames are slow (and may come back, with hysteresis).
   */
  setQuality(q: QualitySetting): void {
    this.qualitySetting = q === 'low' || q === 'high' ? q : 'auto';
    const tier = initialTier(this.qualitySetting, this.mobile);
    this.adaptive = this.qualitySetting === 'auto' ? new AdaptiveQuality(tier) : null;
    this.applyTier(tier);
  }

  get quality(): { setting: QualitySetting; tier: QualityTier; profile: QualityProfile; mobile: boolean } {
    return { setting: this.qualitySetting, tier: this.profile.tier, profile: this.profile, mobile: this.mobile };
  }

  private applyTier(tier: QualityTier): void {
    const p = QUALITY_PROFILES[tier];
    this.profile = p;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, this.maxPixelRatio, p.maxPixelRatio);
    if (this.gl.getPixelRatio() !== ratio) {
      this.gl.setPixelRatio(ratio);
      this.resize();
    }
    const shadows = p.shadows && this.shadowsOpt;
    if (this.gl.shadowMap.enabled !== shadows) {
      this.gl.shadowMap.enabled = shadows;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.lights.setBudget({ lamps: p.lampLights, models: p.modelLights, shadows, shadowMapSize: p.shadowMapSize });
    this.backdrop.setDetail(p.backdropOctaves, p.backdropSegments);
  }

  /** Cost of the last rendered frame plus the measured frame rate. */
  stats(): RenderStats {
    const mem = this.gl.info.memory;
    return {
      drawCalls: this.lastStats.drawCalls,
      triangles: this.lastStats.triangles,
      fps: Math.round(this.fpsMeter.fps * 10) / 10,
      geometries: mem.geometries,
      textures: mem.textures,
      programs: this.gl.info.programs?.length ?? 0,
      tier: this.profile.tier,
      pixelRatio: this.gl.getPixelRatio(),
      contextLost: this.contextLost,
    };
  }

  /**
   * Rebuild everything GPU-side from the current state (after a WebGL context restore): the area's
   * geometry, lighting, backdrop and actor / item views. Camera position, zoom and rotation stay.
   */
  rebuild(): void {
    // three.js re-creates its GL state on restore; make sure every texture is uploaded again
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
          if (v instanceof THREE.Texture && (v.image || (v as THREE.DataTexture).isDataTexture)) v.needsUpdate = true;
        }
        mat.needsUpdate = true;
      }
    });
    this.applyTier(this.profile.tier);
    const st = this.state;
    if (st && this.world) {
      const step = this.rig.step;
      this.setArea({ ...st.area, seen: leadPlayer(st).seen });
      this.rig.step = step;
      this.rig.settle();
      void this.sync(st, []);
    } else if (this.area && this.world) {
      this.cutKey = '';
    }
    this.renderNow();
  }

  /** Current camera yaw step 0..3 (0 = looking north). */
  get cameraStep(): number {
    return this.rig.yawStep;
  }

  screenToTile(x: number, y: number): Pos | null {
    if (!this.area) return null;
    const rect = this.gl.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, hit)) return null;
    const t = worldToTile(hit.x, hit.z);
    return inBounds(t, this.area.width, this.area.height) ? t : null;
  }

  /** Inverse of screenToTile: viewport coordinates of a tile centre (for tooltips / tests). */
  tileToScreen(p: Pos): { x: number; y: number } {
    const rect = this.gl.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(p.x, 0, p.y).project(this.rig.camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  highlightTiles(positions: Pos[], color = '#ffd166'): void {
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.geometry.dispose();
      (this.highlight.material as THREE.Material).dispose();
      this.highlight = null;
    }
    if (!positions.length) return;
    const geo = new THREE.PlaneGeometry(0.92, 0.92);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: col(color), transparent: true, opacity: 0.38, depthWrite: false, blending: THREE.NormalBlending });
    const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
    const m = new THREE.Matrix4();
    positions.forEach((p, i) => mesh.setMatrixAt(i, m.makeTranslation(p.x, 0.03, p.y)));
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.name = 'highlight';
    this.highlight = mesh;
    this.scene.add(mesh);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.gl.setSize(w, h, false);
    this.rig.setViewport(w, h);
    if (this.overlayRects.length || this.autoOverlayEls.size) this.applyOccluders();
    this.reframeNow();
    this.probeDue = true;
    this.seeThroughDue = true;
  }

  /** Render one frame immediately (tests/screenshots). */
  renderNow(): void {
    this.frame(performance.now(), false);
  }

  /**
   * Viewport coordinates of an actor's hp bar fill (centre of the filled part), or null when the
   * actor has no view or its bar is hidden. For tests/debugging.
   */
  hpBarScreen(actorId: string): { x: number; y: number; frac: number } | null {
    const v = this.actors?.views.get(actorId);
    if (!v || !v.root.visible || !v.hp.group.visible) return null;
    v.root.updateWorldMatrix(true, true);
    const p = new THREE.Vector3();
    v.hp.fg.getWorldPosition(p);
    const rect = this.gl.domElement.getBoundingClientRect();
    p.project(this.rig.camera);
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, frac: v.hp.frac };
  }

  /** Viewport coordinates of a point `frac` (0 feet .. 1 top) up an actor's model, or null. For tests. */
  actorScreen(actorId: string, frac = 0.6): { x: number; y: number } | null {
    const v = this.actors?.views.get(actorId);
    if (!v || !v.root.visible) return null;
    const p = v.root.position.clone();
    p.y += v.height * frac;
    p.project(this.rig.camera);
    const rect = this.gl.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  /**
   * Render a frame and read back the sRGB colour at viewport coordinates (x, y) as '#rrggbb'.
   * Reads in the same task as the draw, so it works without preserveDrawingBuffer. For tests.
   */
  samplePixel(x: number, y: number): string {
    return this.samplePixels([[x, y]])[0];
  }

  /** samplePixel for many points from one rendered frame. For tests. */
  samplePixels(points: readonly (readonly [number, number])[]): string[] {
    this.renderNow();
    const canvas = this.gl.domElement;
    const rect = canvas.getBoundingClientRect();
    const ctx = this.gl.getContext();
    const buf = new Uint8Array(4);
    return points.map(([x, y]) => {
      const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(((x - rect.left) / Math.max(1, rect.width)) * canvas.width)));
      const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(((y - rect.top) / Math.max(1, rect.height)) * canvas.height)));
      ctx.readPixels(px, canvas.height - 1 - py, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      return '#' + [buf[0], buf[1], buf[2]].map((n) => n.toString(16).padStart(2, '0')).join('');
    });
  }

  /**
   * Fraction (0..1) of the viewport covered by scene objects whose name matches `names` (walls by
   * default), measured by rendering only those objects on a black background. For tests.
   */
  coverage(names: RegExp = /^(walls|wall-edges)/): number {
    const LAYER = 30;
    const tagged: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (names.test(o.name)) {
        o.layers.enable(LAYER);
        tagged.push(o);
      }
    });
    const cam = this.rig.camera;
    const mask = cam.layers.mask;
    const bg = this.scene.background;
    const fog = this.scene.fog;
    cam.layers.set(LAYER);
    this.scene.background = new THREE.Color(0, 0, 0);
    this.scene.fog = null;
    // lights are filtered by layer too: draw the tagged objects flat white
    const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.scene.overrideMaterial = flat;
    const tm = this.gl.toneMapping;
    let lit = 0;
    let total = 0;
    try {
      this.gl.render(this.scene, cam);
      const ctx = this.gl.getContext();
      const w = ctx.drawingBufferWidth;
      const h = ctx.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      for (let i = 0; i < w * h; i += 7) {
        total++;
        if (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2] > 6) lit++;
      }
    } finally {
      cam.layers.mask = mask;
      this.scene.background = bg;
      this.scene.fog = fog;
      this.scene.overrideMaterial = null;
      flat.dispose();
      this.gl.toneMapping = tm;
      for (const o of tagged) o.layers.disable(LAYER);
    }
    return total ? lit / total : 0;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.gl.domElement.removeEventListener('webglcontextlost', this.onLost);
    this.gl.domElement.removeEventListener('webglcontextrestored', this.onRestored);
    this.resizeObs?.disconnect();
    this.anim.finishAll();
    this.clearArea();
    this.actors?.dispose();
    this.items?.dispose();
    this.thumbnailer?.dispose();
    this.thumbnailer = null;
    this.vfx.clear();
    this.gl.dispose();
    this.gl.domElement.remove();
    this.backdrop.dispose();
    clearMaterialCache();
    clearTextureCache();
    disposeSurfaceTextures();
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  private playerTile(): Pos | null {
    if (!this.playerId || !this.actors) return null;
    return this.actors.views.get(this.playerId)?.tile ?? null;
  }

  private frame(now: number, measure = true): void {
    const ms = now - this.last;
    const dt = Math.min(0.1, Math.max(0, ms / 1000));
    this.last = now;
    if (this.contextLost) return;
    if (measure) this.fpsMeter.sample(ms);
    if (measure && this.adaptive && !(typeof document !== 'undefined' && document.hidden)) {
      const changed = this.adaptive.sample(ms);
      if (changed) this.applyTier(changed);
    }
    this.time += dt;
    const t = this.time;
    this.anim.tick(now);

    const pv = this.playerId ? this.actors?.views.get(this.playerId) : undefined;
    if (pv) this.focus.set(pv.root.position.x, 0, pv.root.position.z);
    this.rig.follow(this.focus);
    const moving = this.rig.update(dt);
    const pt = this.playerTile();
    if (pt) this.updateCutaway(pt);
    if (!moving && !this.anim.busy) {
      // the camera rests: is a framed actor under a page panel, or hidden by the player's model?
      if (this.probeDue || now - this.lastProbe > PROBE_MS) {
        this.probeDue = false;
        this.lastProbe = now;
        if (this.probeOverlays()) this.probeDue = true;
      }
      if (this.seeThroughDue) {
        this.seeThroughDue = false;
        this.updateSeeThrough();
      }
    }

    this.area?.update(t, dt);
    this.actors?.update(t, this.rig.camera);
    this.items?.update(t);

    // model lights: nearest few visible light-emitting actors / terrain to the focus
    const reqs = this.modelLightReqs;
    reqs.length = 0;
    if (this.actors) {
      for (const v of this.actors.views.values()) {
        if (!v.light || !v.root.visible) continue;
        reqs.push({ pos: new THREE.Vector3(v.root.position.x, Math.min(1.2, v.height * 0.8), v.root.position.z), ...v.light });
      }
    }
    if (this.area) for (const s of this.area.lightSources) if (this.area.seenAt(s.tile) > 0) reqs.push(s);
    if (reqs.length > 1) reqs.sort((a, b) => a.pos.distanceToSquared(this.focus) - b.pos.distanceToSquared(this.focus));
    this.lights.update(t, this.focus, this.rig.camera.position, this.area?.lamps ?? [], reqs);
    this.lights.updateFog(this.rig.dist);
    this.backdrop.update(dt, this.rig.camera);

    this.gl.render(this.scene, this.rig.camera);
    const info = this.gl.info.render;
    this.lastStats.drawCalls = info.calls;
    this.lastStats.triangles = info.triangles;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Radius (tiles, Euclidean) of the engine's current field of view: the farthest tile marked visible
 * (seen = 2) from the player. 0 when nothing is visible.
 */
export function visibleRadius(area: { map: Pick<AreaState['map'], 'width'>; seen: SeenArray }, from: Pos): number {
  const W = area.map.width;
  let best = 0;
  const seen = area.seen as ArrayLike<number>;
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] !== 2) continue;
    const dx = (i % W) - from.x;
    const dy = Math.floor(i / W) - from.y;
    const d = dx * dx + dy * dy;
    if (d > best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * The panel an element hit over the map belongs to: the element itself, or its largest ancestor that
 * still leaves the player's screen point (`centre`) uncovered, stays under a third of the viewport and
 * is not a page-wide wrapper (body, the renderer's own container or anything holding it).
 */
export function overlayPanel(hit: Element, container: Element, centre: { x: number; y: number }, viewportArea: number): Element | null {
  const covers = (r: DOMRect) => centre.x >= r.left && centre.x <= r.right && centre.y >= r.top && centre.y <= r.bottom;
  const doc = hit.ownerDocument;
  const top = (e: Element) => e === doc?.body || e === doc?.documentElement || e.contains(container);
  if (top(hit)) return null;
  const r0 = hit.getBoundingClientRect();
  if (r0.width <= 0 || r0.height <= 0 || covers(r0)) return null;
  let el = hit;
  for (let p = hit.parentElement; p && !top(p); p = p.parentElement) {
    const r = p.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue; // display: contents wrappers
    if (covers(r) || r.width * r.height > viewportArea / 3) break;
    // a wrapper that lets touches through is layout, not a panel (corner columns wider than their parts)
    try {
      if (getComputedStyle(p).pointerEvents === 'none') break;
    } catch {
      /* no styles (detached) */
    }
    el = p;
  }
  return el;
}

function rectsKey(rects: readonly OverlayRect[]): string {
  return rects.map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`).join(';');
}
