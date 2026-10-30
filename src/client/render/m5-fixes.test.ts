/**
 * M5 renderer fixes: item thumbnails (issues/M5-item-thumbnails.md) and auto framing that keeps
 * actors out from under desktop overlay panels (issues/M5-actors-under-overlays.md).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../schema/refs';
import type { WorldSpec } from '../../schema/world';
import { CameraRig, OCCLUDER_PAD, underOverlay, type OverlayRect } from './camera';
import type { AreaMap, AreaState, Tile } from '../../engine/types';
import { AreaView, type FoggedArea } from './tiles';
import { buildModel, animateModel } from './models';
import { ItemThumbnailer, encodePixels, linearToSrgbByte, type ThumbCanvas, type ThumbGl } from './thumbnails';

function loadWorld(name: string): WorldSpec {
  const res = parseWorld(JSON.parse(readFileSync(join(__dirname, `../../../content/worlds/${name}.json`), 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.world;
}

// ---------------------------------------------------------------------------
// thumbnails
// ---------------------------------------------------------------------------

interface FakeGl extends ThumbGl {
  log: string[];
  lost: boolean;
  target: THREE.WebGLRenderTarget | null;
  clearColor: THREE.Color;
  clearAlpha: number;
  rendered: { scene: THREE.Object3D; camera: THREE.Camera }[];
  /** alpha the fake writes for drawn pixels (0: draws nothing) */
  alpha: number;
}

function fakeGl(): FakeGl {
  const gl: FakeGl = {
    log: [],
    lost: false,
    target: null,
    clearColor: new THREE.Color(0x101014),
    clearAlpha: 1,
    rendered: [],
    alpha: 255,
    shadowMap: { enabled: true },
    getRenderTarget: () => gl.target,
    setRenderTarget: (t) => {
      gl.target = t;
      gl.log.push(t ? 'target:thumb' : 'target:screen');
    },
    getClearColor: (c) => c.copy(gl.clearColor),
    getClearAlpha: () => gl.clearAlpha,
    setClearColor: (c, a = 1) => {
      gl.clearColor = new THREE.Color(c);
      gl.clearAlpha = a;
    },
    clear: () => gl.log.push('clear'),
    render: (scene, camera) => {
      gl.log.push(`render:shadows=${gl.shadowMap.enabled}`);
      gl.rendered.push({ scene, camera });
    },
    readRenderTargetPixels: (_t, _x, _y, w, h, buf) => {
      // a vertical ramp: bottom row (first in GL order) dark, top row bright
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          buf[i] = y === 0 ? 0 : 255;
          buf[i + 1] = 128;
          buf[i + 2] = 64;
          buf[i + 3] = gl.alpha;
        }
    },
    getContext: () => ({ isContextLost: () => gl.lost }),
  };
  return gl;
}

interface FakeCanvas extends ThumbCanvas {
  data: Uint8ClampedArray | null;
  drawn: { from: unknown; dw: number; dh: number } | null;
}

function fakeCanvasFactory(made: FakeCanvas[]) {
  return (w: number, h: number): ThumbCanvas => {
    const c: FakeCanvas = {
      width: w,
      height: h,
      data: null,
      drawn: null,
      getContext: () => ({
        imageSmoothingEnabled: false,
        createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }) as unknown as ImageData,
        putImageData: (img: ImageData) => {
          c.data = img.data;
        },
        drawImage: (src: unknown, _sx: number, _sy: number, _sw: number, _sh: number, _dx: number, _dy: number, dw: number, dh: number) => {
          c.drawn = { from: src, dw, dh };
        },
        clearRect: () => {},
      }),
      toDataURL: () => `data:image/png;base64,${w}x${h}`,
    };
    made.push(c);
    return c;
  };
}

describe('item thumbnails', () => {
  const world = loadWorld('viking-lawspeaker-althing');
  const withModel = world.items.filter((i) => i.model);

  it('the viking world has items with models (the backpack in the playtest)', () => {
    expect(withModel.length).toBeGreaterThan(3);
  });

  it('renders each known item once into a 64 px PNG data URL and caches it', () => {
    const gl = fakeGl();
    const made: FakeCanvas[] = [];
    const th = new ItemThumbnailer(gl, { canvas: fakeCanvasFactory(made) });
    const a = th.get(world, withModel[0]!.id);
    expect(a).toBe('data:image/png;base64,64x64');
    expect(th.renders).toBe(1);
    // the 128 px render is filtered down into the 64 px image
    const out = made.find((c) => c.width === 64)!;
    expect(out.drawn).toMatchObject({ dw: 64, dh: 64 });
    expect(th.get(world, withModel[0]!.id)).toBe(a);
    expect(th.renders).toBe(1);
    th.get(world, withModel[1]!.id);
    expect(th.renders).toBe(2);
    // the model was put into the thumbnail scene and taken out again; the camera looks at it
    const { scene, camera } = gl.rendered[0]!;
    expect(scene.children.some((c) => c.name === 'model')).toBe(false);
    expect(scene.children.some((c) => (c as THREE.Light).isLight)).toBe(true);
    expect((camera as THREE.PerspectiveCamera).isPerspectiveCamera).toBe(true);
  });

  it('frames every item model of every world inside the thumbnail camera', () => {
    for (const name of ['fixture-western', 'fixture-dream', 'viking-lawspeaker-althing', 'alien-twilight-migration']) {
      const w = loadWorld(name);
      const gl = fakeGl();
      let checked = 0;
      gl.render = (scene, camera) => {
        const model = scene.children.find((c) => c.name === 'model')!;
        const box = new THREE.Box3().setFromObject(model);
        const corners: THREE.Vector3[] = [];
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
        let span = 0;
        for (const c of corners) {
          const v = c.project(camera);
          // inside the image
          expect(Math.abs(v.x), `${name}`).toBeLessThanOrEqual(0.98);
          expect(Math.abs(v.y), `${name}`).toBeLessThanOrEqual(0.98);
          span = Math.max(span, Math.abs(v.x), Math.abs(v.y));
        }
        // and big enough to read: the bounding box fills most of the image
        expect(span, name).toBeGreaterThan(0.75);
        checked++;
      };
      const th = new ItemThumbnailer(gl, { canvas: fakeCanvasFactory([]) });
      for (const it of w.items) th.get(w, it.id);
      expect(checked).toBe(w.items.filter((i) => i.model).length);
    }
  });

  it('restores the render target, clear colour and shadow setting', () => {
    const gl = fakeGl();
    const th = new ItemThumbnailer(gl, { canvas: fakeCanvasFactory([]) });
    th.get(world, withModel[0]!.id);
    expect(gl.log).toEqual(['target:thumb', 'clear', 'render:shadows=false', 'target:screen']);
    expect(gl.target).toBeNull();
    expect(gl.clearColor.getHex()).toBe(0x101014);
    expect(gl.clearAlpha).toBe(1);
    expect(gl.shadowMap.enabled).toBe(true);
  });

  it('never answers for unknown def ids; a lost context answers null without caching', () => {
    const gl = fakeGl();
    const th = new ItemThumbnailer(gl, { canvas: fakeCanvasFactory([]) });
    expect(th.get(world, 'no-such-item')).toBeNull();
    gl.lost = true;
    expect(th.get(world, withModel[0]!.id)).toBeNull();
    expect(th.renders).toBe(0);
    gl.lost = false;
    expect(th.get(world, withModel[0]!.id)).toMatch(/^data:image\/png/);
  });

  it('an empty render (nothing drawn) and a missing canvas give null', () => {
    const gl = fakeGl();
    gl.alpha = 0;
    expect(new ItemThumbnailer(gl, { canvas: fakeCanvasFactory([]) }).get(world, withModel[0]!.id)).toBeNull();
    expect(new ItemThumbnailer(fakeGl(), { canvas: () => null }).get(world, withModel[0]!.id)).toBeNull();
  });

  it('a new world clears the cache (def ids are per world)', () => {
    const gl = fakeGl();
    const th = new ItemThumbnailer(gl, { canvas: fakeCanvasFactory([]) });
    th.get(world, withModel[0]!.id);
    const other = { ...world };
    th.get(other, withModel[0]!.id);
    expect(th.renders).toBe(2);
  });

  it('read-back pixels are flipped to top-row-first and encoded to sRGB', () => {
    expect(linearToSrgbByte(0)).toBe(0);
    expect(linearToSrgbByte(1)).toBe(255);
    // linear 0.5 is sRGB ≈ 188
    expect(linearToSrgbByte(0.5)).toBe(188);
    const src = new Uint8Array([
      // bottom row (GL first): red
      255, 0, 0, 255,
      // top row: half green, half alpha
      0, 128, 0, 128,
    ]);
    const out = new Uint8ClampedArray(8);
    encodePixels(src, 1, 2, out);
    expect([...out.slice(0, 4)]).toEqual([0, linearToSrgbByte(128 / 255), 0, 128]);
    expect([...out.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });
});

// ---------------------------------------------------------------------------
// framing around overlay panels
// ---------------------------------------------------------------------------

describe('auto framing keeps actors out from under overlay panels', () => {
  const W = 1280;
  const H = 800;
  // the desktop layout of the playtest (pt-desktop-r1-western-34-boss.png): HUD and log on the left,
  // goal bar on top, Search / Wait context buttons above the hotbar at the bottom
  const HUD: OverlayRect = { left: 12, top: 12, right: 322, bottom: 228 };
  const LOG: OverlayRect = { left: 12, top: 662, right: 322, bottom: 788 };
  const GOAL: OverlayRect = { left: 325, top: 52, right: 965, bottom: 102 };
  const CTX: OverlayRect = { left: 550, top: 650, right: 730, bottom: 692 };
  const BAR: OverlayRect = { left: 380, top: 700, right: 902, bottom: 788 };
  const ALL = [HUD, LOG, GOAL, CTX, BAR];

  function rig(): CameraRig {
    const r = new CameraRig(1);
    r.setViewport(W, H);
    r.follow(new THREE.Vector3(20, 0, 20), true);
    r.settle();
    return r;
  }
  const screen = (r: CameraRig, p: THREE.Vector3) => {
    const v = p.clone().project(r.camera);
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
  };
  const inside = (s: { x: number; y: number }, rc: OverlayRect) => s.x >= rc.left && s.x <= rc.right && s.y >= rc.top && s.y <= rc.bottom;

  it('underOverlay: padded hit test that ignores rects over the view centre', () => {
    const centre = { x: 640, y: 400 };
    expect(underOverlay(100, 100, [HUD], centre)).toBe(true);
    expect(underOverlay(322 + OCCLUDER_PAD - 1, 100, [HUD], centre)).toBe(true);
    expect(underOverlay(322 + OCCLUDER_PAD + 1, 100, [HUD], centre)).toBe(false);
    // a panel over the player can never be escaped by zooming out: it does not count
    expect(underOverlay(640, 400, [{ left: 600, top: 380, right: 700, bottom: 420 }], centre)).toBe(false);
  });

  it('a boss just below the player that stands under the context buttons is framed above them', () => {
    const r = rig();
    r.setZoom(12, true);
    // a tile straight south of the player whose feet the plain framing leaves under the buttons
    let boss: THREE.Vector3 | null = null;
    for (let dz = 2; dz < 12; dz++) {
      const p = new THREE.Vector3(20, 0, 20 + dz);
      const pts = [p, p.clone().setY(1.6)];
      r.setFrameDist(r.distanceToFrame(pts, r.userDist));
      r.settle();
      if (inside(screen(r, pts[0]!), CTX)) {
        boss = p;
        break;
      }
    }
    expect(boss, 'some tile below the player sits under the context buttons with plain framing').not.toBeNull();
    const pts = [boss!, boss!.clone().setY(1.6)];
    const plain = r.distanceToFrame(pts, r.userDist);
    r.setOccluders(ALL);
    const d = r.distanceToFrame(pts, r.userDist);
    expect(d).toBeGreaterThan(plain);
    r.setFrameDist(d);
    r.settle();
    for (const p of pts) for (const rc of ALL) expect(inside(screen(r, p), rc)).toBe(false);
  });

  it('an actor under the top-left HUD (the Dust Coyote) is pulled into view', () => {
    const r = rig();
    let coyote: THREE.Vector3 | null = null;
    for (let d = 2; d < 14 && !coyote; d++) {
      const p = new THREE.Vector3(20 - d, 0, 20 - Math.round(d * 0.6));
      if (inside(screen(r, p), HUD) && inside(screen(r, p.clone().setY(1.2)), HUD)) coyote = p;
    }
    expect(coyote).not.toBeNull();
    r.setOccluders([HUD]);
    const pts = [coyote!, coyote!.clone().setY(1.2)];
    r.setFrameDist(r.distanceToFrame(pts, r.userDist));
    r.settle();
    for (const p of pts) expect(inside(screen(r, p), HUD)).toBe(false);
  });

  it('actors clear of every panel do not change the zoom', () => {
    const r = rig();
    r.setOccluders(ALL);
    const pts = [new THREE.Vector3(22, 0, 19), new THREE.Vector3(22, 1.6, 19)];
    expect(r.distanceToFrame(pts, r.userDist)).toBeCloseTo(r.userDist, 5);
  });
});

// ---------------------------------------------------------------------------
// draw calls of animated terrain models (DoD §10 item 12)
// ---------------------------------------------------------------------------

describe('animated terrain models are compacted', () => {
  it('each placed copy costs far fewer meshes than its primitives, and still animates', () => {
    const world = loadWorld('alien-twilight-migration');
    const def = world.terrains!.find((t) => t.id === 'grazing-mossback')!;
    expect(def.model && (def.model.idle ?? 'bob') !== 'none').toBe(true);
    const raw = buildModel(def.model!, { lights: false });
    let rawMeshes = 0;
    raw.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) rawMeshes++;
    });
    const rows = ['#######', '#S.mm.#', '#.mm.T#', '#######'];
    const tiles: Tile[] = [];
    for (const r of rows) for (const ch of r) tiles.push(ch === '#' ? { kind: 'wall' } : ch === 'S' ? { kind: 'start' } : ch === 'T' ? { kind: 'transition' } : ch === 'm' ? { kind: 'floor', terrain: def.id } : { kind: 'floor' });
    const W = rows[0]!.length;
    const map: AreaMap = { width: W, height: rows.length, tiles, start: { x: 1, y: 1 }, exit: { x: 5, y: 2 }, regions: [] };
    const state: FoggedArea = { index: 0, map, actors: [], items: [], seen: new Array(tiles.length).fill(2), discoveredRegions: [], gmBudget: 0 };
    const view = new AreaView(world, world.areas[0]!, state);
    const copies: THREE.Object3D[] = [];
    view.group.traverse((o) => {
      if (o.name === 'model' && o.userData.tile !== undefined) copies.push(o);
    });
    expect(copies.length).toBe(4);
    for (const c of copies) {
      let n = 0;
      c.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) n++;
      });
      expect(n).toBeLessThan(rawMeshes);
      expect(n).toBeLessThanOrEqual(Math.ceil(rawMeshes * 0.7));
    }
    // the idle animation still drives the body
    const body = copies[0]!.getObjectByName('body')!;
    animateModel(copies[0]!, 0.3);
    const a = body.rotation.z;
    animateModel(copies[0]!, 1.1);
    expect(body.rotation.z).not.toBeCloseTo(a, 5);
    view.dispose();
  });
});

describe('doors are compacted', () => {
  it('a door costs at most 5 meshes and still swings open', () => {
    const world = loadWorld('viking-lawspeaker-althing');
    const rows = ['#####', '#S.T#', '##D##', '#...#', '#####'];
    const tiles: Tile[] = [];
    for (const r of rows) for (const ch of r) tiles.push(ch === '#' ? { kind: 'wall' } : ch === 'S' ? { kind: 'start' } : ch === 'T' ? { kind: 'transition' } : ch === 'D' ? { kind: 'door' } : { kind: 'floor' });
    const W = rows[0]!.length;
    const map: AreaMap = { width: W, height: rows.length, tiles, start: { x: 1, y: 1 }, exit: { x: 3, y: 1 }, regions: [] };
    const state: FoggedArea = { index: 0, map, actors: [], items: [], seen: new Array(tiles.length).fill(2), discoveredRegions: [], gmBudget: 0 };
    const view = new AreaView(world, world.areas[0]!, state);
    const doors = (view as unknown as { doors: Map<number, { obj: THREE.Object3D; panel: THREE.Object3D; k: number }> }).doors;
    expect(doors.size).toBe(1);
    const d = [...doors.values()][0]!;
    let n = 0;
    d.obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    expect(n).toBeLessThanOrEqual(5);
    // the moving panel still carries its own meshes
    let inPanel = 0;
    d.panel.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) inPanel++;
    });
    expect(inPanel).toBeGreaterThan(0);
    const closed = d.panel.rotation.y + d.panel.position.x;
    const opened = map.tiles.map((t) => (t.kind === 'door' ? { kind: 'door_open' as const } : t));
    view.updateTiles({ ...map, tiles: opened });
    for (let i = 0; i < 60; i++) view.update(i * 0.05, 0.05);
    expect(d.panel.rotation.y + d.panel.position.x).not.toBeCloseTo(closed, 2);
    view.dispose();
  });
});
