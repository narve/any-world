/**
 * Tilted perspective camera that smoothly follows a target, orbits in animated 90° steps and zooms
 * within limits. Step 0 looks north from the south (map row 0 at the top of the screen).
 */
import * as THREE from 'three';
import { yawForStep, normStep } from './coords';

export const CAMERA_PITCH_DEG = 50;
export const CAMERA_FOV_DEG = 34;
export const MIN_DIST = 6;
export const MAX_DIST = 30;
/** tiles visible to each side of the player at the default zoom (landscape) */
export const DEFAULT_HALF_WIDTH = 8.5;
/** tiles visible above / below the player at the default zoom (portrait is framed by this) */
export const DEFAULT_HALF_HEIGHT = 6.2;
/** never fewer tiles than this to each side (narrow portrait phones) … */
export const MIN_HALF_WIDTH = 3.6;
/** … or above / below (short landscape phones with a hotbar) */
export const MIN_HALF_HEIGHT = 3.0;

/** Unobscured part of the viewport as fractions of its width / height (HUD and hotbar insets removed). */
export interface SafeFraction {
  w: number;
  h: number;
}

/**
 * Default camera distance for an aspect ratio: about DEFAULT_HALF_WIDTH tiles to each side of the
 * player on landscape screens; portrait screens are framed by height instead (≈ 6 tiles above and
 * below), so phones do not zoom out until the character is a speck. Narrow and short screens still
 * keep at least MIN_HALF_WIDTH / MIN_HALF_HEIGHT tiles around the player. `safe` is the part of the
 * viewport not covered by HUD / hotbar (Renderer.setViewportInsets); framing uses only that part.
 */
export function defaultDistance(aspect: number, fovDeg = CAMERA_FOV_DEG, safe: SafeFraction = { w: 1, h: 1 }): number {
  const tv = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const sw = Math.max(0.2, Math.min(1, safe.w));
  const sh = Math.max(0.2, Math.min(1, safe.h));
  const tw = tv * Math.max(0.3, aspect) * sw; // visible half-width per unit distance
  const th = tv * sh; // visible half-height per unit distance
  const preferred = Math.min(DEFAULT_HALF_WIDTH / tw, DEFAULT_HALF_HEIGHT / th);
  const floor = Math.max(MIN_HALF_WIDTH / tw, MIN_HALF_HEIGHT / th);
  return Math.min(MAX_DIST, Math.max(MIN_DIST, preferred, floor));
}

/** Viewport insets in CSS px (areas covered by HUD, hotbar, notch …). */
export interface ViewInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A screen rectangle in CSS px (same unit and origin as setViewport: the canvas' top-left). */
export interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** CSS px kept between a framed actor and an overlay panel's edge */
export const OCCLUDER_PAD = 6;

/** Margins of auto framing, as fractions of the unobscured half-width / half-height. */
export interface FrameMargin {
  x: number;
  top: number;
  bottom: number;
}
export const DEFAULT_FRAME_MARGIN: FrameMargin = { x: 0.1, top: 0.12, bottom: 0.3 };
/** auto framing may shift the image by up to this share of the framed half-width / half-height … */
export const PAN_SHARE = 0.6;
/** … tried in this many steps to each side */
export const PAN_STEPS = 8;

/**
 * true when a point at canvas px (x, y) is hidden by one of `rects` (grown by `pad`). Rects that
 * contain `centre` (the follow target's screen position, where the player stands) never count:
 * zooming out moves everything towards the centre, so they could never be escaped.
 */
export function underOverlay(x: number, y: number, rects: readonly OverlayRect[], centre: { x: number; y: number }, pad = OCCLUDER_PAD): boolean {
  for (const r of rects) {
    if (centre.x >= r.left && centre.x <= r.right && centre.y >= r.top && centre.y <= r.bottom) continue;
    if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return true;
  }
  return false;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  readonly desired = new THREE.Vector3();
  /** integer step; yaw = -step·90° */
  step = 0;
  yaw = 0;
  dist = defaultDistance(1.6);
  distTarget = defaultDistance(1.6);
  /** the distance the player chose (wheel / setZoom); follows the aspect ratio until they zoom */
  userDist = defaultDistance(1.6);
  /** true once the player zoomed (or setZoom was called): the aspect ratio no longer picks the zoom */
  private userZoomed = false;
  /** minimum distance that keeps everything that must be on screen framed (0 = no constraint) */
  frameDist = 0;
  pitch = (CAMERA_PITCH_DEG * Math.PI) / 180;
  private lookOffset = new THREE.Vector3(0, 0.45, 0);
  /** viewport size in CSS px and the insets covered by overlay UI */
  private viewW = 1;
  private viewH = 1;
  insets: ViewInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  /** overlay panels (canvas CSS px) that auto framing keeps points out of; see setOccluders */
  occluders: OverlayRect[] = [];
  /**
   * Screen shift of the whole image (CSS px, +x right, +y down) that auto framing chose to move framed
   * actors out from under overlay panels (see frame()); `pan` eases towards `panTarget`.
   */
  pan = { x: 0, y: 0 };
  panTarget = { x: 0, y: 0 };

  constructor(aspect = 1) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.1, 220);
    this.apply();
  }

  /** Snap or ease the follow target to a world position. */
  follow(pos: THREE.Vector3, snap = false): void {
    this.desired.copy(pos);
    if (snap) {
      this.target.copy(pos);
      this.apply();
    }
  }

  rotate(dir: -1 | 1): void {
    this.step += dir;
  }

  get yawStep(): number {
    return normStep(this.step);
  }

  /** delta > 0 zooms out. Multiplicative so it feels even at every distance. */
  zoom(delta: number): void {
    const f = Math.exp(Math.max(-2, Math.min(2, delta)) * 0.15);
    // start from what is on screen (which may be auto-framed further out than the player's choice)
    this.userDist = Math.min(MAX_DIST, Math.max(MIN_DIST, this.distTarget * f));
    this.userZoomed = true;
    // an explicit zoom-in overrides auto framing until the renderer next reframes (next turn)
    if (delta < 0) this.frameDist = 0;
    this.retarget();
  }

  /**
   * Multiplicative zoom for pinch gestures: f > 1 moves the camera closer (fingers spreading),
   * f < 1 further away. Applies to what is on screen, like zoom().
   */
  zoomBy(f: number): void {
    if (!(f > 0) || !Number.isFinite(f)) return;
    this.userDist = Math.min(MAX_DIST, Math.max(MIN_DIST, this.distTarget / f));
    this.userZoomed = true;
    if (f > 1) this.frameDist = 0;
    this.retarget();
  }

  setZoom(dist: number, snap = false): void {
    this.userDist = Math.min(MAX_DIST, Math.max(MIN_DIST, dist));
    this.userZoomed = true;
    this.retarget();
    if (snap) this.dist = this.distTarget;
  }

  /** Minimum distance needed to keep the important things framed; the user's zoom wins when larger. */
  setFrameDist(d: number): void {
    this.frameDist = Math.max(0, Math.min(MAX_DIST, d));
    this.retarget();
  }

  private retarget(): void {
    this.distTarget = Math.min(MAX_DIST, Math.max(MIN_DIST, this.userDist, this.frameDist));
  }

  /**
   * Smallest camera distance in [from, MAX_DIST] at which every point projects inside the viewport
   * shrunk by `margin` (NDC units) on each side and outside every occluder (setOccluders), for the current target/yaw/pitch/aspect. Returns
   * MAX_DIST when even that cannot frame them all. Does not move the camera.
   */
  distanceToFrame(points: readonly THREE.Vector3[], from: number, margin: FrameMargin = DEFAULT_FRAME_MARGIN): number {
    if (points.length === 0) return 0;
    return this.frame(points, from, { margin, pan: false }).dist;
  }

  /**
   * Auto framing: the camera distance (≥ `from`) and image shift (CSS px) that keep every point inside
   * the unobscured viewport (shrunk by `margin`) and out from under every occluder. At each distance,
   * from the nearest outwards, it first tries no shift, then the current shift (so the view does not
   * wander from turn to turn), then shifts of growing length up to PAN_SHARE of the unobscured
   * rectangle: moving the view into the free band beats zooming out. `player` points (the player's
   * feet and head) must stay inside the viewport and clear of the occluders too. Does not move the
   * camera; apply with setFrameDist / setPan.
   */
  frame(
    points: readonly THREE.Vector3[],
    from: number,
    opts: { player?: readonly THREE.Vector3[]; margin?: FrameMargin; pan?: boolean } = {},
  ): { dist: number; pan: { x: number; y: number } } {
    const zero = { x: 0, y: 0 };
    if (points.length === 0) return { dist: 0, pan: zero };
    const margin = opts.margin ?? DEFAULT_FRAME_MARGIN;
    const player = opts.player ?? [];
    const cam = this.camera.clone();
    const v = new THREE.Vector3();
    const W = this.viewW;
    const H = this.viewH;
    // the unobscured rectangle in canvas px (insets removed), shrunk by the margins
    const b = this.safeNdc();
    const sx = (b.right - b.left) / 2;
    const sy = (b.top - b.bottom) / 2;
    const toX = (n: number) => ((n + 1) / 2) * W;
    const toY = (n: number) => ((1 - n) / 2) * H;
    const xl = toX(b.left + margin.x * sx);
    const xr = toX(b.right - margin.x * sx);
    const yt = toY(b.top - margin.top * sy);
    const yb = toY(b.bottom + margin.bottom * sy);
    // the player may come closer to the edges than framed actors, but never leave the safe rect
    const pxl = toX(b.left + 0.06 * sx);
    const pxr = toX(b.right - 0.06 * sx);
    const pyt = toY(b.top - 0.06 * sy);
    const pyb = toY(b.bottom + 0.06 * sy);
    const occ = this.occluders;
    // the follow target projects to the middle of the unobscured rectangle (without any shift)
    const centre = { x: toX((b.left + b.right) / 2), y: toY((b.top + b.bottom) / 2) };
    // panels over the centre can never be escaped; they do not count for the player either
    const live = occ.filter((r) => !(centre.x >= r.left && centre.x <= r.right && centre.y >= r.top && centre.y <= r.bottom));
    const pans: { x: number; y: number }[] = [zero];
    if (opts.pan !== false) {
      const cur = this.panTarget;
      if (cur.x !== 0 || cur.y !== 0) pans.push({ ...cur });
      const mx = ((xr - xl) / 2) * PAN_SHARE;
      const my = ((yb - yt) / 2) * PAN_SHARE;
      const grid: { x: number; y: number }[] = [];
      for (let i = -PAN_STEPS; i <= PAN_STEPS; i++)
        for (let j = -PAN_STEPS; j <= PAN_STEPS; j++) if (i || j) grid.push({ x: (i / PAN_STEPS) * mx, y: (j / PAN_STEPS) * my });
      grid.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y));
      pans.push(...grid);
    }
    const sp: { x: number; y: number }[] = [];
    const pp: { x: number; y: number }[] = [];
    const project = (list: readonly THREE.Vector3[], out: { x: number; y: number }[]): boolean => {
      out.length = 0;
      for (const p of list) {
        v.copy(p).project(cam);
        if (v.z > 1) return false;
        out.push({ x: toX(v.x), y: toY(v.y) });
      }
      return true;
    };
    const fitsWith = (pan: { x: number; y: number }): boolean => {
      for (const s of sp) {
        const x = s.x + pan.x;
        const y = s.y + pan.y;
        if (x < xl || x > xr || y < yt || y > yb) return false;
        if (live.length && underOverlay(x, y, live, centre)) return false;
      }
      if (pan.x === 0 && pan.y === 0) return true;
      for (const s of pp) {
        const x = s.x + pan.x;
        const y = s.y + pan.y;
        if (x < pxl || x > pxr || y < pyt || y > pyb) return false;
        if (live.length && underOverlay(x, y, live, centre)) return false;
      }
      return true;
    };
    let d = Math.max(MIN_DIST, from);
    for (;;) {
      // the image without any shift; a shift moves every projected point by the same px
      this.place(cam, this.desired, this.yawTarget(), d);
      this.offsetCamera(cam, zero);
      if (project(points, sp) && project(player, pp)) for (const pan of pans) if (fitsWith(pan)) return { dist: d, pan: { ...pan } };
      if (d >= MAX_DIST) return { dist: MAX_DIST, pan: zero };
      d = Math.min(MAX_DIST, d * 1.08);
    }
  }

  /** Ease the image shift towards `pan` (CSS px, see frame()); snap with settle(). */
  setPan(pan: { x: number; y: number }): void {
    const ok = (n: number) => (Number.isFinite(n) ? n : 0);
    this.panTarget = { x: ok(pan.x), y: ok(pan.y) };
  }

  /** Where the camera will come to rest (follow target, yaw step and zoom reached). */
  restingPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const c = Math.cos(this.pitch) * this.distTarget;
    const yaw = this.yawTarget();
    return out.set(this.desired.x + Math.sin(yaw) * c, this.desired.y + Math.sin(this.pitch) * this.distTarget, this.desired.z + Math.cos(yaw) * c);
  }

  private yawTarget(): number {
    return yawForStep(this.step);
  }

  setAspect(aspect: number): void {
    this.setViewport(aspect, 1);
  }

  /**
   * Viewport size in CSS px (or any unit; only ratios matter). Updates the aspect, the projection
   * offset for the insets, and the default zoom while the player has not chosen one.
   */
  setViewport(width: number, height: number): void {
    this.viewW = Math.max(1e-6, width);
    this.viewH = Math.max(1e-6, height);
    this.updateProjection();
  }

  /**
   * Areas of the viewport covered by overlay UI (CSS px, same unit as setViewport). The projection is
   * shifted so the follow target sits in the middle of the uncovered rectangle, and the default zoom
   * and auto framing only count that rectangle.
   */
  setInsets(insets: Partial<ViewInsets>): void {
    const c = (n: number | undefined) => (Number.isFinite(n) ? Math.max(0, n as number) : 0);
    this.insets = { top: c(insets.top), bottom: c(insets.bottom), left: c(insets.left), right: c(insets.right) };
    this.updateProjection();
  }

  /**
   * Overlay panels over the viewport (CSS px from its top-left, same unit as setViewport) that do not
   * shrink the view like insets do (corner HUD, log, hotbar on desktops): distanceToFrame also zooms
   * out until no framed point lies under one of them.
   */
  setOccluders(rects: readonly OverlayRect[]): void {
    this.occluders = rects.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
  }

  /** Unobscured fraction of the viewport. */
  safeFraction(): SafeFraction {
    const i = this.clampedInsets();
    return { w: (this.viewW - i.left - i.right) / this.viewW, h: (this.viewH - i.top - i.bottom) / this.viewH };
  }

  /** The unobscured rectangle in NDC (-1..1, y up). */
  safeNdc(): { left: number; right: number; top: number; bottom: number } {
    const i = this.clampedInsets();
    return {
      left: -1 + (2 * i.left) / this.viewW,
      right: 1 - (2 * i.right) / this.viewW,
      top: 1 - (2 * i.top) / this.viewH,
      bottom: -1 + (2 * i.bottom) / this.viewH,
    };
  }

  /** insets limited so at least 20% of each dimension stays uncovered */
  private clampedInsets(): ViewInsets {
    const fit = (a: number, b: number, size: number): [number, number] => {
      const max = size * 0.8;
      if (a + b <= max) return [a, b];
      const k = max / (a + b);
      return [a * k, b * k];
    };
    const [top, bottom] = fit(this.insets.top, this.insets.bottom, this.viewH);
    const [left, right] = fit(this.insets.left, this.insets.right, this.viewW);
    return { top, bottom, left, right };
  }

  /**
   * Shift `cam`'s image so the view centre lands in the middle of the uncovered rectangle, plus `pan`
   * (CSS px), and update its projection.
   */
  private offsetCamera(cam: THREE.PerspectiveCamera, pan: { x: number; y: number }): void {
    const W = this.viewW;
    const H = this.viewH;
    const i = this.clampedInsets();
    cam.aspect = W / H;
    const sx = (i.left - i.right) / 2 + pan.x;
    const sy = (i.top - i.bottom) / 2 + pan.y;
    if (Math.abs(sx) > 1e-6 || Math.abs(sy) > 1e-6) cam.setViewOffset(W, H, -sx, -sy, W, H);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }

  private updateProjection(): void {
    const W = this.viewW;
    const H = this.viewH;
    this.offsetCamera(this.camera, this.pan);
    if (!this.userZoomed) {
      this.userDist = defaultDistance(W / H, this.camera.fov, this.safeFraction());
      this.retarget();
      this.dist = this.distTarget;
      this.apply();
    }
  }

  /** true while still moving (useful to keep rendering) */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 9);
    const yawTarget = yawForStep(this.step);
    const panning = Math.abs(this.pan.x - this.panTarget.x) > 0.25 || Math.abs(this.pan.y - this.panTarget.y) > 0.25;
    const moving =
      this.target.distanceToSquared(this.desired) > 1e-6 || Math.abs(this.yaw - yawTarget) > 1e-4 || Math.abs(this.dist - this.distTarget) > 1e-3 || panning;
    this.target.lerp(this.desired, k);
    this.yaw += (yawTarget - this.yaw) * (1 - Math.exp(-dt * 10));
    this.dist += (this.distTarget - this.dist) * k;
    if (panning) {
      this.pan.x += (this.panTarget.x - this.pan.x) * k;
      this.pan.y += (this.panTarget.y - this.pan.y) * k;
      this.offsetCamera(this.camera, this.pan);
    } else if (this.pan.x !== this.panTarget.x || this.pan.y !== this.panTarget.y) {
      this.pan = { ...this.panTarget };
      this.offsetCamera(this.camera, this.pan);
    }
    this.apply();
    return moving;
  }

  /** finish any easing immediately */
  settle(): void {
    this.target.copy(this.desired);
    this.yaw = yawForStep(this.step);
    this.dist = this.distTarget;
    if (this.pan.x !== this.panTarget.x || this.pan.y !== this.panTarget.y) {
      this.pan = { ...this.panTarget };
      this.offsetCamera(this.camera, this.pan);
    }
    this.apply();
  }

  private apply(): void {
    this.place(this.camera, this.target, this.yaw, this.dist);
  }

  private place(cam: THREE.PerspectiveCamera, target: THREE.Vector3, yaw: number, dist: number): void {
    const c = Math.cos(this.pitch) * dist;
    cam.position.set(target.x + Math.sin(yaw) * c, target.y + Math.sin(this.pitch) * dist, target.z + Math.cos(yaw) * c);
    cam.lookAt(target.x + this.lookOffset.x, target.y + this.lookOffset.y, target.z + this.lookOffset.z);
    cam.updateMatrixWorld();
  }
}
