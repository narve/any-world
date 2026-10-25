/**
 * Item thumbnails for the UI (hotbar, backpack, trade): each item's model is rendered once into one
 * shared offscreen render target on the game's own WebGL context, read back, and cached as a PNG
 * data URL per def id. Nothing here touches the main scene or camera.
 *
 *   const th = new ItemThumbnailer(renderer.gl)
 *   th.get(world, defId) → 'data:image/png;base64,…' | null   (null: unknown def id, no model, no
 *                                                              canvas, or the context is lost)
 *
 * The thumbnail shows the item as it really is (untinted): callers must not show it for items the
 * player has not identified (the UI uses the glyph with the run appearance colour for those).
 *
 * Render targets skip the renderer's output colour conversion and tone mapping, so the read-back
 * pixels are linear; they are encoded to sRGB here before going into the 2D canvas.
 */
import * as THREE from 'three';
import type { WorldSpec } from '../../schema/world';
import { buildModel, animateModel } from './models';

/** px of the cached image (UI glyphs are ≤ 48 CSS px; 64 stays sharp at 1.33× zoom) */
export const THUMB_SIZE = 64;
/** px of the render target: rendered at 2× and filtered down for antialiasing */
export const THUMB_RENDER_SIZE = 128;
/** share of the image (NDC half-extent) the item's projected bounding box fills */
export const THUMB_FILL = 0.86;

/** What the thumbnailer needs from a THREE.WebGLRenderer (a fake in unit tests). */
export interface ThumbGl {
  getRenderTarget(): THREE.WebGLRenderTarget | null;
  setRenderTarget(t: THREE.WebGLRenderTarget | null): void;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  readRenderTargetPixels(target: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number, buffer: Uint8Array): void;
  getContext(): { isContextLost(): boolean };
  shadowMap: { enabled: boolean };
}

/** Minimal 2D canvas surface (document canvas in browsers; injectable for tests). */
export interface ThumbCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): ThumbCtx | null;
  toDataURL(type?: string): string;
}
export interface ThumbCtx {
  createImageData(w: number, h: number): ImageData;
  putImageData(img: ImageData, x: number, y: number): void;
  drawImage(src: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality?: string;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export type CanvasFactory = (w: number, h: number) => ThumbCanvas | null;

function documentCanvas(w: number, h: number): ThumbCanvas | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c as unknown as ThumbCanvas;
}

/** linear 0..1 → sRGB byte */
export function linearToSrgbByte(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

const SRGB_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = linearToSrgbByte(i / 255);
  return lut;
})();

/**
 * Converts read-back RGBA rows (bottom row first, linear) into top-row-first sRGB RGBA. Alpha is kept
 * as is: the target is cleared to transparent black and models are opaque, so soft edges only come
 * from the 2× downscale afterwards.
 */
export function encodePixels(src: Uint8Array, w: number, h: number, out: Uint8ClampedArray): void {
  for (let y = 0; y < h; y++) {
    const from = (h - 1 - y) * w * 4;
    const to = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      out[to + x] = SRGB_LUT[src[from + x]!]!;
      out[to + x + 1] = SRGB_LUT[src[from + x + 1]!]!;
      out[to + x + 2] = SRGB_LUT[src[from + x + 2]!]!;
      out[to + x + 3] = src[from + x + 3]!;
    }
  }
}

export interface ThumbnailerOptions {
  canvas?: CanvasFactory;
  size?: number;
  renderSize?: number;
}

export class ItemThumbnailer {
  private cache = new Map<string, string | null>();
  private world: WorldSpec | null = null;
  private target: THREE.WebGLRenderTarget | null = null;
  private scene: THREE.Scene | null = null;
  private camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  private readonly makeCanvas: CanvasFactory;
  private readonly size: number;
  private readonly renderSize: number;
  /** renders done so far (tests: the cache must stop repeats) */
  renders = 0;

  constructor(
    private readonly gl: ThumbGl,
    opts: ThumbnailerOptions = {},
  ) {
    this.makeCanvas = opts.canvas ?? documentCanvas;
    this.size = opts.size ?? THUMB_SIZE;
    this.renderSize = opts.renderSize ?? THUMB_RENDER_SIZE;
  }

  /** A new world invalidates every cached image (def ids are per world). */
  setWorld(world: WorldSpec | null): void {
    if (world === this.world) return;
    this.world = world;
    this.cache.clear();
  }

  /** Cached thumbnail of item `defId` of `world`, rendering it on first use. */
  get(world: WorldSpec, defId: string): string | null {
    this.setWorld(world);
    if (this.cache.has(defId)) return this.cache.get(defId)!;
    const def = world.items.find((i) => i.id === defId);
    if (!def || !def.model) {
      this.cache.set(defId, null);
      return null;
    }
    // a lost context renders nothing: answer null but try again once it is back
    if (this.gl.getContext().isContextLost()) return null;
    const url = this.render(def.model);
    if (url) this.cache.set(defId, url);
    return url;
  }

  private ensureScene(): THREE.Scene {
    if (this.scene) return this.scene;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e6, 0x3a3f4a, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.5, 3, 2.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 1.0);
    rim.position.set(-2, 1.5, -2);
    scene.add(rim);
    this.scene = scene;
    return scene;
  }

  /**
   * Points the camera at `box` from the front, a little above, and moves it until the box's projected
   * corners fill FILL of the image (a sphere fit leaves thin items tiny).
   */
  private frame(box: THREE.Box3): void {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(0.02, sphere.radius);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dir = new THREE.Vector3(0, 0.55, 1).normalize();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    const place = (dist: number): number => {
      this.camera.near = Math.max(0.001, dist - r * 1.5);
      this.camera.far = dist + r * 1.5;
      this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
      this.camera.lookAt(sphere.center);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      let span = 0;
      for (const c of corners) {
        v.copy(c).project(this.camera);
        span = Math.max(span, Math.abs(v.x), Math.abs(v.y));
      }
      return span;
    };
    // start from the sphere fit (always fits), then close in; never nearer than the sphere's surface
    let dist = (r / Math.sin(fov / 2)) * 1.04;
    const minDist = r * 1.6;
    for (let i = 0; i < 4; i++) {
      const span = place(dist);
      if (!(span > 0)) break;
      const next = Math.max(minDist, dist * (span / THUMB_FILL));
      if (Math.abs(next - dist) < 1e-4) break;
      dist = next;
    }
    // never leave it overflowing the image
    for (let i = 0; i < 8 && place(dist) > 0.97; i++) dist *= 1.06;
  }

  private render(spec: NonNullable<WorldSpec['items'][number]['model']>): string | null {
    const canvas = this.makeCanvas(this.renderSize, this.renderSize);
    const out = this.makeCanvas(this.size, this.size);
    const ctx = canvas?.getContext('2d');
    const octx = out?.getContext('2d');
    if (!canvas || !out || !ctx || !octx) return null;

    const scene = this.ensureScene();
    const model = buildModel(spec, { lights: false, phase: 0 });
    animateModel(model, 0);
    // three-quarter view from the front, slightly above; fit the bounding sphere
    model.rotation.y = -0.6;
    model.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return null;
    // long thin things (staffs, swords, keys) lie along the diagonal, where the square has most room
    const size = box.getSize(new THREE.Vector3());
    if (size.y > 2.2 * Math.max(size.x, size.z)) {
      model.rotation.z = -Math.PI / 4;
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
    } else if (Math.max(size.x, size.z) > 2.2 * size.y && size.x > size.z) {
      model.rotation.z = Math.PI / 6;
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
    }
    this.frame(box);
    scene.add(model);

    const n = this.renderSize;
    this.target ??= new THREE.WebGLRenderTarget(n, n, { depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    const prevTarget = this.gl.getRenderTarget();
    const prevColor = this.gl.getClearColor(new THREE.Color());
    const prevAlpha = this.gl.getClearAlpha();
    const prevShadows = this.gl.shadowMap.enabled;
    const px = new Uint8Array(n * n * 4);
    try {
      this.gl.shadowMap.enabled = false;
      this.gl.setRenderTarget(this.target);
      this.gl.setClearColor(0x000000, 0);
      this.gl.clear(true, true, false);
      this.gl.render(scene, this.camera);
      this.gl.readRenderTargetPixels(this.target, 0, 0, n, n, px);
      this.renders++;
    } finally {
      this.gl.setRenderTarget(prevTarget);
      this.gl.setClearColor(prevColor, prevAlpha);
      this.gl.shadowMap.enabled = prevShadows;
      scene.remove(model);
    }
    // nothing drawn (all transparent): no thumbnail
    let any = false;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i]! > 8) {
        any = true;
        break;
      }
    }
    if (!any) return null;
    const img = ctx.createImageData(n, n);
    encodePixels(px, n, n, img.data);
    ctx.putImageData(img, 0, 0);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.clearRect(0, 0, this.size, this.size);
    octx.drawImage(canvas, 0, 0, n, n, 0, 0, this.size, this.size);
    return out.toDataURL('image/png');
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.cache.clear();
    this.scene = null;
  }
}
