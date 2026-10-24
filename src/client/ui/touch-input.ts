/**
 * Map input in one place (DESIGN §6, §6b): mouse, pen and touch on the map element all become the
 * same few callbacks, which the controller turns into PlayerActions / UI intents.
 *
 *   mouse / pen: move → hover(tile) · click → click(tile, primary) · right click → click(tile, secondary)
 *   touch:       tap → tap(tile) · long press → longPress(tile) (inspect)
 *                two fingers: pinch → camera.zoomBy · twist → camera.rotateStep (render/touch.ts)
 *
 * `PressTracker` is the pure tap / long-press / drag classifier (unit-tested without a DOM);
 * `attachMapInput` is the thin DOM binding. Taps never produce the browser's emulated mouse events
 * (the touch pointerdown is cancelled), so a tap is never also a click.
 */
import { TouchCameraGesture } from '../render/touch';
import type { TilePos } from './input';

/** a press must be held this long (ms) to count as a long press */
export const LONG_PRESS_MS = 500;
/** a finger may wander this far (CSS px) and still tap */
export const TAP_SLOP = 10;
/** a mouse may move this far between down and up and still click (camera drags don't click) */
export const CLICK_SLOP = 6;

export type PressResult = 'tap' | 'long' | null;

/**
 * One-finger press classification. Feed it pointer events with timestamps:
 *  - `down` starts a press (a second finger cancels it: that is a gesture)
 *  - `move` beyond TAP_SLOP turns it into a drag (no tap, no long press)
 *  - `due(now)` is true once the press has been held for LONG_PRESS_MS: call `fireLong()` then
 *  - `up` returns 'tap' for a short still press, null otherwise (a fired long press eats the up)
 */
export class PressTracker {
  private id: number | null = null;
  private start = { x: 0, y: 0, t: 0 };
  private dragged = false;
  private longFired = false;
  private fingers = new Set<number>();

  constructor(readonly opts: { longMs: number; slop: number } = { longMs: LONG_PRESS_MS, slop: TAP_SLOP }) {}

  get pressing(): boolean {
    return this.id !== null;
  }

  /** where the current press started */
  get origin(): { x: number; y: number } {
    return { x: this.start.x, y: this.start.y };
  }

  down(id: number, x: number, y: number, t: number): void {
    this.fingers.add(id);
    if (this.fingers.size > 1) {
      this.cancel();
      return;
    }
    this.id = id;
    this.start = { x, y, t };
    this.dragged = false;
    this.longFired = false;
  }

  move(id: number, x: number, y: number): void {
    if (id !== this.id) return;
    if (Math.hypot(x - this.start.x, y - this.start.y) > this.opts.slop) this.dragged = true;
  }

  /** the long press is ready to fire */
  due(now: number): boolean {
    return this.id !== null && !this.dragged && !this.longFired && now - this.start.t >= this.opts.longMs;
  }

  fireLong(): void {
    this.longFired = true;
  }

  up(id: number, t: number): PressResult {
    this.fingers.delete(id);
    if (id !== this.id) return null;
    this.id = null;
    if (this.dragged) return null;
    if (this.longFired) return null;
    if (t - this.start.t >= this.opts.longMs) return 'long';
    return 'tap';
  }

  /** a second finger, a camera gesture or pointercancel: forget the press */
  cancel(): void {
    this.id = null;
    this.dragged = true;
  }

  /** a finger left (pointercancel): it no longer counts towards gestures */
  release(id: number): void {
    this.fingers.delete(id);
    if (id === this.id) this.cancel();
  }
}

export interface MapInputHandlers {
  /** viewport coordinates → tile (renderer pick), or null off the map */
  pick(clientX: number, clientY: number): TilePos | null;
  /** mouse hover moved to another tile (null: left the map) */
  hover?(pos: TilePos | null): void;
  /** mouse / pen click */
  click?(pos: TilePos, button: 'primary' | 'secondary'): void;
  /** touch tap on a tile */
  tap?(pos: TilePos, at: { x: number; y: number }): void;
  /** touch long press on a tile (inspect) */
  longPress?(pos: TilePos, at: { x: number; y: number }): void;
  /** any touch on the map started (hide transient cards, unlock audio…) */
  touchStart?(): void;
  /** pinch / twist target (absent: no camera gestures) */
  camera?: { zoomBy(f: number): void; rotateStep(dir: -1 | 1): void };
  /** a two-finger gesture started / ended */
  gesture?(active: boolean): void;
  /** input is ignored while this returns true (a panel has the input) */
  blocked?(): boolean;
}

export interface MapInputBinding {
  detach(): void;
}

/** wires `el` (the map / canvas host) to `h`; see the module comment */
export function attachMapInput(el: HTMLElement, h: MapInputHandlers): MapInputBinding {
  const press = new PressTracker();
  const gesture = new TouchCameraGesture();
  let gestureOn = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hovered: TilePos | null = null;
  let mouseDown: { x: number; y: number } | null = null;
  const blocked = () => !!h.blocked?.();
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const setGesture = (on: boolean) => {
    if (on === gestureOn) return;
    gestureOn = on;
    h.gesture?.(on);
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      if (e.button === 0 || e.button === 2) mouseDown = { x: e.clientX, y: e.clientY };
      return;
    }
    // no emulated mouse events, no text selection, no double-tap zoom from this touch
    if (e.cancelable) e.preventDefault();
    h.touchStart?.();
    gesture.down(e.pointerId, e.clientX, e.clientY);
    press.down(e.pointerId, e.clientX, e.clientY, performance.now());
    if (gesture.active) {
      clearTimer();
      setGesture(true);
      return;
    }
    clearTimer();
    const x = e.clientX;
    const y = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      if (!press.due(performance.now() + 1)) return;
      press.fireLong();
      if (blocked()) return;
      const pos = h.pick(x, y);
      if (pos) h.longPress?.(pos, { x, y });
    }, press.opts.longMs);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      if (blocked()) return;
      const t = h.pick(e.clientX, e.clientY);
      if (!same(t, hovered)) {
        hovered = t;
        h.hover?.(t);
      }
      return;
    }
    press.move(e.pointerId, e.clientX, e.clientY);
    const out = gesture.move(e.pointerId, e.clientX, e.clientY);
    if (!gesture.active) return;
    if (e.cancelable) e.preventDefault();
    if (blocked() || !h.camera) return;
    if (out.zoom !== 1) h.camera.zoomBy(out.zoom);
    if (out.rotate) h.camera.rotateStep(out.rotate);
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      const d = mouseDown;
      mouseDown = null;
      if (!d || blocked()) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP || (e.button !== 0 && e.button !== 2)) return;
      const t = h.pick(e.clientX, e.clientY);
      if (t) h.click?.(t, e.button === 2 ? 'secondary' : 'primary');
      return;
    }
    clearTimer();
    gesture.up(e.pointerId);
    const r = press.up(e.pointerId, performance.now());
    if (!gesture.active && gesture.pointers === 0) setGesture(false);
    if (!r || blocked()) return;
    const pos = h.pick(e.clientX, e.clientY);
    if (!pos) return;
    if (r === 'tap') h.tap?.(pos, { x: e.clientX, y: e.clientY });
    else h.longPress?.(pos, { x: e.clientX, y: e.clientY });
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      mouseDown = null;
      return;
    }
    clearTimer();
    gesture.up(e.pointerId);
    press.release(e.pointerId);
    if (gesture.pointers === 0) setGesture(false);
  };

  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || !hovered) return;
    hovered = null;
    h.hover?.(null);
  };
  const onContext = (e: Event) => e.preventDefault();

  el.addEventListener('pointerdown', onDown, { passive: false });
  el.addEventListener('pointermove', onMove, { passive: false });
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('contextmenu', onContext);
  return {
    detach() {
      clearTimer();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('contextmenu', onContext);
    },
  };
}

function same(a: TilePos | null, b: TilePos | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
}

// ---------------------------------------------------------------------------
// what a tap on the map means (pure)
// ---------------------------------------------------------------------------

export interface TapContext {
  player: TilePos;
  /** the living actor on the tapped tile, if any is visible */
  actor?: { id: string; hostile: boolean; canTalk: boolean; canAttack: boolean } | null;
}

export type TapDecision = { kind: 'talk'; targetId: string } | { kind: 'attack'; targetId: string } | { kind: 'travel' };

/**
 * A tap next to the player on someone means talk to them (non-hostile NPC) or attack them
 * (hostile, or anyone the engine lets you attack who cannot talk); every other tap walks there
 * (the session's click-to-travel: path-walk that stops when something happens).
 */
export function tapDecision(pos: TilePos, ctx: TapContext): TapDecision {
  const a = ctx.actor;
  const adjacent = Math.max(Math.abs(pos.x - ctx.player.x), Math.abs(pos.y - ctx.player.y)) === 1;
  if (a && adjacent) {
    if (!a.hostile && a.canTalk) return { kind: 'talk', targetId: a.id };
    if (a.canAttack && (a.hostile || !a.canTalk)) return { kind: 'attack', targetId: a.id };
  }
  return { kind: 'travel' };
}
