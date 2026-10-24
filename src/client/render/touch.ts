/**
 * Two-finger camera gestures for touch screens: pinch to zoom, twist to rotate in 90° steps.
 *
 * `TouchCameraGesture` is pure (feed it pointer positions, it returns zoom factors and rotate
 * steps) so it is unit tested without a DOM. `attachTouchCamera(renderer, element)` wires it to
 * pointer events for clients that want the default behaviour; one-finger taps / long-presses are
 * left alone for the input layer (it only consumes events while two fingers are down).
 *
 * Conventions match Renderer.zoomBy / rotateStep: a zoom factor > 1 moves the camera closer
 * (fingers spreading apart), and twisting the fingers clockwise on screen turns the world clockwise
 * (rotateStep(-1)), so the map follows the fingers.
 */

export interface GestureOutput {
  /** multiply the view scale by this (1 = no change); > 1 zooms in */
  zoom: number;
  /** -1 / 1 rotate step to apply now, 0 none */
  rotate: -1 | 0 | 1;
}

export interface GestureOptions {
  /** twist (degrees) that triggers one 90° rotate step */
  twistDeg: number;
  /** pinch ratio changes smaller than this are ignored (jitter) */
  minZoomDelta: number;
}

const DEFAULTS: GestureOptions = { twistDeg: 40, minZoomDelta: 0.004 };

interface Pt {
  x: number;
  y: number;
}

export class TouchCameraGesture {
  readonly opts: GestureOptions;
  private pts = new Map<number, Pt>();
  private lastDist = 0;
  private baseAngle = 0;

  constructor(opts: Partial<GestureOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** true while two (or more) pointers are down: the gesture owns the input */
  get active(): boolean {
    return this.pts.size >= 2;
  }

  get pointers(): number {
    return this.pts.size;
  }

  down(id: number, x: number, y: number): void {
    this.pts.set(id, { x, y });
    if (this.pts.size === 2) this.rebase();
  }

  up(id: number): void {
    this.pts.delete(id);
    if (this.pts.size === 2) this.rebase();
  }

  cancel(): void {
    this.pts.clear();
  }

  move(id: number, x: number, y: number): GestureOutput {
    const none: GestureOutput = { zoom: 1, rotate: 0 };
    const p = this.pts.get(id);
    if (!p) return none;
    p.x = x;
    p.y = y;
    if (this.pts.size < 2) return none;
    const [a, b] = this.pair();
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    let zoom = 1;
    if (this.lastDist > 0 && dist > 0) {
      const r = dist / this.lastDist;
      if (Math.abs(r - 1) >= this.opts.minZoomDelta) {
        zoom = r;
        this.lastDist = dist;
      }
    }
    let rotate: -1 | 0 | 1 = 0;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const d = wrapAngle(ang - this.baseAngle);
    const th = (this.opts.twistDeg * Math.PI) / 180;
    if (Math.abs(d) >= th) {
      // screen y points down, so a growing angle is a clockwise twist → world clockwise → step -1
      rotate = d > 0 ? -1 : 1;
      this.baseAngle = ang;
    }
    return { zoom, rotate };
  }

  private pair(): [Pt, Pt] {
    const it = this.pts.values();
    return [it.next().value as Pt, it.next().value as Pt];
  }

  private rebase(): void {
    const [a, b] = this.pair();
    this.lastDist = Math.hypot(b.x - a.x, b.y - a.y);
    this.baseAngle = Math.atan2(b.y - a.y, b.x - a.x);
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** The part of the Renderer the touch helper drives. */
export interface TouchCameraTarget {
  zoomBy(f: number): void;
  rotateStep(dir: -1 | 1): void;
}

/**
 * Pinch-zoom and twist-rotate on `el` (the canvas host) for touch pointers. Returns a detach
 * function. Single-finger input passes through untouched; while two fingers are down the events
 * are consumed (and `onGesture` is told, so the input layer can cancel a pending tap/long-press).
 */
export function attachTouchCamera(target: TouchCameraTarget, el: HTMLElement, onGesture?: (active: boolean) => void): () => void {
  const g = new TouchCameraGesture();
  let was = false;
  const notify = () => {
    if (g.active !== was) {
      was = g.active;
      onGesture?.(was);
    }
  };
  const isTouch = (e: PointerEvent) => e.pointerType === 'touch';
  const down = (e: PointerEvent) => {
    if (!isTouch(e)) return;
    g.down(e.pointerId, e.clientX, e.clientY);
    notify();
  };
  const move = (e: PointerEvent) => {
    if (!isTouch(e)) return;
    const out = g.move(e.pointerId, e.clientX, e.clientY);
    if (!g.active) return;
    e.preventDefault();
    if (out.zoom !== 1) target.zoomBy(out.zoom);
    if (out.rotate) target.rotateStep(out.rotate);
  };
  const up = (e: PointerEvent) => {
    if (!isTouch(e)) return;
    g.up(e.pointerId);
    notify();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: false });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    g.cancel();
  };
}
