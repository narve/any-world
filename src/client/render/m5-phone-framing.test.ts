/**
 * Phone framing around the bottom panels (issues/M5-phone-hostiles-under-panels.md): auto framing
 * shifts the view into the free band before it zooms out, keeps the player clear, and the renderer
 * finds the page's panels over a framed actor by itself (overlayPanel).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraRig, PAN_SHARE, underOverlay, type OverlayRect } from './camera';
import { overlayPanel } from './index';

type Pt = { x: number; y: number };

function screen(r: CameraRig, p: THREE.Vector3, W: number, H: number): Pt {
  const v = p.clone().project(r.camera);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}
const inside = (s: Pt, rc: OverlayRect) => s.x >= rc.left && s.x <= rc.right && s.y >= rc.top && s.y <= rc.bottom;
const body = (p: THREE.Vector3, h = 1.2) => [p, p.clone().setY(h)];

describe('phone portrait: hostiles under the bottom panels', () => {
  // iPhone 15 portrait (393 × 852): HUD + strip + goal on top are insets, the log ticker with the
  // bag / rules / help buttons, the Search / Wait row and the hotbar sit over the bottom of the map
  const W = 393;
  const H = 852;
  const TICKER: OverlayRect = { left: 8, top: 640, right: 385, bottom: 700 };
  const CTX: OverlayRect = { left: 8, top: 704, right: 385, bottom: 752 };
  const HOTBAR: OverlayRect = { left: 8, top: 760, right: 385, bottom: 830 };
  const PANELS = [TICKER, CTX, HOTBAR];
  const P = new THREE.Vector3(20, 0, 20);

  function rig(): CameraRig {
    const r = new CameraRig(1);
    r.setViewport(W, H);
    r.setInsets({ top: 190, bottom: 20 });
    r.follow(P, true);
    r.settle();
    return r;
  }

  /** a tile straight below the player whose feet the plain (unshifted) framing leaves under a panel */
  function hiddenBelow(r: CameraRig): THREE.Vector3 {
    for (let dz = 2; dz < 14; dz++) {
      const p = new THREE.Vector3(20, 0, 20 + dz);
      const d = r.frame(body(p), r.userDist, { pan: false }).dist;
      if (Math.abs(d - r.userDist) > 1e-6) continue;
      if (PANELS.some((rc) => inside(screen(r, p, W, H), rc))) return p;
    }
    throw new Error('no tile below the player sits under the bottom panels');
  }

  it('without panels the hostile stands under the ticker (the playtest picture)', () => {
    const r = rig();
    const p = hiddenBelow(r);
    expect(PANELS.some((rc) => inside(screen(r, p, W, H), rc))).toBe(true);
  });

  it('shifts the view up into the free band instead of zooming out', () => {
    const r = rig();
    const foe = hiddenBelow(r);
    r.setOccluders(PANELS);
    const me = body(P, 1.6);
    const f = r.frame(body(foe), r.userDist, { player: me });
    expect(f.dist).toBeCloseTo(r.userDist, 6);
    expect(f.pan.y).toBeLessThan(0);
    // zoom-only framing had to move the camera away for the same hostile
    expect(r.distanceToFrame(body(foe), r.userDist)).toBeGreaterThan(r.userDist);
    r.setFrameDist(f.dist);
    r.setPan(f.pan);
    r.settle();
    for (const p of body(foe)) for (const rc of PANELS) expect(inside(screen(r, p, W, H), rc)).toBe(false);
    // the player stays on screen and clear of the panels
    for (const p of me) {
      const s = screen(r, p, W, H);
      expect(s.y).toBeGreaterThan(190);
      expect(s.y).toBeLessThan(TICKER.top);
    }
  });

  it('eases the shift in, and settle() snaps it', () => {
    const r = rig();
    const foe = hiddenBelow(r);
    r.setOccluders(PANELS);
    const f = r.frame(body(foe), r.userDist, { player: body(P, 1.6) });
    const before = screen(r, foe, W, H);
    r.setPan(f.pan);
    expect(r.update(1 / 60)).toBe(true);
    const mid = screen(r, foe, W, H);
    expect(mid.y).toBeLessThan(before.y);
    expect(mid.y).toBeGreaterThan(before.y + f.pan.y - 1);
    r.settle();
    expect(r.pan).toEqual(f.pan);
    expect(screen(r, foe, W, H).y).toBeCloseTo(before.y + f.pan.y, 3);
    expect(r.update(1 / 60)).toBe(false);
  });

  it('keeps the current shift while it still works (no wandering from turn to turn)', () => {
    const r = rig();
    const foe = hiddenBelow(r);
    r.setOccluders(PANELS);
    const f = r.frame(body(foe), r.userDist, { player: body(P, 1.6) });
    // a larger shift than needed that still fits is kept
    const bigger = { x: f.pan.x, y: f.pan.y - 30 };
    r.setPan(bigger);
    const g = r.frame(body(foe), r.userDist, { player: body(P, 1.6) });
    expect(g.pan).toEqual(bigger);
  });

  it('no shift and no zoom when every actor is clear of the panels', () => {
    const r = rig();
    r.setOccluders(PANELS);
    const f = r.frame(body(new THREE.Vector3(21, 0, 19)), r.userDist, { player: body(P, 1.6) });
    expect(f.pan).toEqual({ x: 0, y: 0 });
    expect(f.dist).toBeCloseTo(r.userDist, 6);
  });

  it('zooms out when no shift within PAN_SHARE can clear the actor', () => {
    const r = rig();
    // a panel over the whole lower half (bar the centre) cannot be escaped by shifting alone
    const huge: OverlayRect = { left: 0, top: 560, right: W, bottom: H };
    r.setZoom(12, true);
    r.setOccluders([huge]);
    const foe = new THREE.Vector3(20, 0, 24);
    const f = r.frame(body(foe), r.userDist, { player: body(P, 1.6) });
    expect(PAN_SHARE).toBeLessThan(1);
    expect(f.dist).toBeGreaterThan(12);
    expect(f.dist).toBeLessThan(30);
    r.setFrameDist(f.dist);
    r.setPan(f.pan);
    r.settle();
    for (const p of body(foe)) expect(inside(screen(r, p, W, H), huge)).toBe(false);
  });
});

describe('phone landscape: hostiles under the context column', () => {
  const W = 852;
  const H = 393;
  const COL: OverlayRect = { left: 690, top: 40, right: 852, bottom: 393 };
  const P = new THREE.Vector3(20, 0, 20);

  it('shifts the view sideways so an actor east of the player leaves the column', () => {
    const r = new CameraRig(1);
    r.setViewport(W, H);
    r.setInsets({ top: 70, bottom: 0 });
    r.follow(P, true);
    r.settle();
    let foe: THREE.Vector3 | null = null;
    for (let dx = 2; dx < 16 && !foe; dx++) {
      const p = new THREE.Vector3(20 + dx, 0, 20);
      if (Math.abs(r.frame(body(p), r.userDist, { pan: false }).dist - r.userDist) > 1e-6) continue;
      if (inside(screen(r, p, W, H), COL)) foe = p;
    }
    expect(foe).not.toBeNull();
    r.setOccluders([COL]);
    const f = r.frame(body(foe!), r.userDist, { player: body(P, 1.6) });
    expect(f.pan.x).toBeLessThan(0);
    expect(f.dist).toBeCloseTo(r.userDist, 6);
    r.setFrameDist(f.dist);
    r.setPan(f.pan);
    r.settle();
    for (const p of body(foe!)) expect(underOverlay(screen(r, p, W, H).x, screen(r, p, W, H).y, [COL], { x: W / 2, y: H / 2 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// overlayPanel: which element of the page counts as the panel over an actor
// ---------------------------------------------------------------------------

interface FakeEl {
  name: string;
  rect: DOMRect;
  parentElement: FakeEl | null;
  ownerDocument: { body: unknown; documentElement: unknown };
  getBoundingClientRect(): DOMRect;
  contains(o: unknown): boolean;
}

function fake(name: string, l: number, t: number, r: number, b: number, parent: FakeEl | null, doc: FakeEl['ownerDocument']): FakeEl {
  const rect = { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON: () => ({}) } as DOMRect;
  const el: FakeEl = {
    name,
    rect,
    parentElement: parent,
    ownerDocument: doc,
    getBoundingClientRect: () => rect,
    contains(o: unknown) {
      for (let e = o as FakeEl | null; e; e = e.parentElement) if (e === el) return true;
      return false;
    },
  };
  return el;
}

describe('overlayPanel', () => {
  const doc = { body: null as unknown, documentElement: null as unknown };
  const html = fake('html', 0, 0, 393, 852, null, doc);
  const body = fake('body', 0, 0, 393, 852, html, doc);
  doc.body = body;
  doc.documentElement = html;
  const canvasHost = fake('#game-canvas', 0, 0, 393, 852, body, doc);
  const uiRoot = fake('#ui-root', 0, 0, 393, 852, body, doc);
  const game = fake('.aw-game', 0, 0, 393, 852, uiRoot, doc);
  const bottom = fake('.aw-bottom-centre', 0, 620, 393, 852, game, doc);
  const ctx = fake('.aw-ctx', 8, 704, 385, 752, bottom, doc);
  const btn = fake('.aw-ctx-btn', 300, 704, 385, 752, ctx, doc);
  const label = fake('.aw-ctx-label', 320, 718, 370, 738, btn, doc);
  const centre = { x: 196, y: 420 };
  const area = 393 * 852;
  const panel = (e: FakeEl) => overlayPanel(e as unknown as Element, canvasHost as unknown as Element, centre, area) as unknown as FakeEl | null;

  it('climbs from the hit element to the panel it belongs to', () => {
    // the bottom wrapper is small enough and clear of the player too: it is the panel
    expect(panel(label)?.name).toBe('.aw-bottom-centre');
  });

  it('stops below a wrapper that covers the player or most of the screen', () => {
    const big = fake('.aw-sheet', 0, 300, 393, 852, game, doc);
    const part = fake('.aw-sheet-row', 0, 700, 393, 760, big, doc);
    expect(panel(part)?.name).toBe('.aw-sheet-row');
  });

  it('never returns the page, the map container or a panel over the player', () => {
    expect(panel(body)).toBeNull();
    expect(panel(game)).toBeNull();
    const overPlayer = fake('.aw-modal', 50, 300, 350, 600, game, doc);
    expect(panel(overPlayer)).toBeNull();
  });
});
