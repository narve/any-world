/**
 * M3 renderer: quality tiers, adaptive quality, touch gestures, viewport insets / responsive framing
 * and model compaction (draw-call budget).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AdaptiveQuality, FpsMeter, QUALITY_PROFILES, initialTier, isMobileDevice } from './quality';
import { TouchCameraGesture } from './touch';
import { CameraRig, defaultDistance, MAX_DIST, USER_MAX_DIST, MIN_HALF_HEIGHT, MIN_HALF_WIDTH, CAMERA_FOV_DEG } from './camera';
import { compactModel } from './models/merge';
import { buildModel, animateModel } from './models';
import { LightRig, LAMP_LIGHTS, MODEL_LIGHTS } from './lighting';
import { Backdrop } from './backdrop';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

describe('quality profiles', () => {
  it('low caps the pixel ratio at 1.5, drops shadows and trims lights; high keeps ≤ 2', () => {
    expect(QUALITY_PROFILES.high.maxPixelRatio).toBeLessThanOrEqual(2);
    expect(QUALITY_PROFILES.low.maxPixelRatio).toBeLessThanOrEqual(1.5);
    expect(QUALITY_PROFILES.low.shadows).toBe(false);
    expect(QUALITY_PROFILES.high.shadows).toBe(true);
    expect(QUALITY_PROFILES.low.lampLights).toBeLessThan(QUALITY_PROFILES.high.lampLights);
    expect(QUALITY_PROFILES.low.backdropOctaves).toBeLessThan(QUALITY_PROFILES.high.backdropOctaves);
    expect(QUALITY_PROFILES.high.lampLights).toBeLessThanOrEqual(LAMP_LIGHTS);
    expect(QUALITY_PROFILES.high.modelLights).toBeLessThanOrEqual(MODEL_LIGHTS);
  });

  it('detects phones and tablets, not touch-screen laptops with a mouse', () => {
    expect(isMobileDevice({ userAgent: IPHONE_UA, maxTouchPoints: 5, coarsePointer: true, screenWidth: 390, screenHeight: 844 })).toBe(true);
    expect(isMobileDevice({ userAgent: PIXEL_UA, maxTouchPoints: 5, coarsePointer: true, screenWidth: 412, screenHeight: 915 })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 5 })).toBe(true); // iPadOS
    expect(isMobileDevice({ userAgent: DESKTOP_UA, maxTouchPoints: 0, coarsePointer: false, screenWidth: 1920, screenHeight: 1080 })).toBe(false);
    expect(isMobileDevice({ userAgent: DESKTOP_UA, maxTouchPoints: 10, coarsePointer: false, screenWidth: 1920, screenHeight: 1080 })).toBe(false);
    expect(isMobileDevice({})).toBe(false);
  });

  it('auto starts low on mobile and high elsewhere; explicit settings win', () => {
    expect(initialTier('auto', true)).toBe('low');
    expect(initialTier('auto', false)).toBe('high');
    expect(initialTier('high', true)).toBe('high');
    expect(initialTier('low', false)).toBe('low');
  });
});

describe('AdaptiveQuality', () => {
  const feed = (a: AdaptiveQuality, ms: number, total: number) => {
    const changes: string[] = [];
    for (let t = 0; t < total; t += ms) {
      const c = a.sample(ms);
      if (c) changes.push(c);
    }
    return changes;
  };

  it('stays high at a solid 60 fps', () => {
    const a = new AdaptiveQuality('high');
    expect(feed(a, 16.7, 20000)).toEqual([]);
    expect(a.tier).toBe('high');
    expect(a.fps).toBeGreaterThan(55);
  });

  it('drops to low after sustained slow frames, not after one hitch', () => {
    const a = new AdaptiveQuality('high');
    feed(a, 16.7, 2000);
    // one long frame (GC, shader compile) is not a trend
    expect(a.sample(120)).toBeNull();
    expect(feed(a, 16.7, 2000)).toEqual([]);
    // tab switch gap is ignored entirely
    expect(a.sample(5000)).toBeNull();
    expect(a.tier).toBe('high');
    // 30 fps for a few seconds: drop
    expect(feed(a, 33, 5000)).toEqual(['low']);
    expect(a.tier).toBe('low');
  });

  it('comes back to high only after a long run of fast frames, and locks low after repeated drops', () => {
    const a = new AdaptiveQuality('high', { maxDowngrades: 2 });
    expect(feed(a, 33, 6000)).toEqual(['low']);
    // a few good seconds are not enough (hysteresis)
    expect(feed(a, 16.7, 5000)).toEqual([]);
    expect(feed(a, 16.7, 10000)).toEqual(['high']);
    expect(feed(a, 33, 6000)).toEqual(['low']);
    expect(a.locked).toBe(true);
    expect(feed(a, 16.7, 60000)).toEqual([]);
    expect(a.tier).toBe('low');
  });

  it('never upgrades a device that started low (phones)', () => {
    const a = new AdaptiveQuality('low');
    expect(feed(a, 16.7, 60000)).toEqual([]);
    expect(a.tier).toBe('low');
  });

  it('FpsMeter measures the frame rate', () => {
    const m = new FpsMeter();
    for (let i = 0; i < 120; i++) m.sample(1000 / 30);
    expect(m.fps).toBeGreaterThan(28);
    expect(m.fps).toBeLessThan(32);
  });
});

describe('TouchCameraGesture', () => {
  it('ignores one finger, pinches with two', () => {
    const g = new TouchCameraGesture();
    g.down(1, 100, 100);
    expect(g.active).toBe(false);
    expect(g.move(1, 140, 100)).toEqual({ zoom: 1, rotate: 0 });
    g.down(2, 200, 100); // 60 px apart
    expect(g.active).toBe(true);
    const out = g.move(2, 260, 100); // 120 px apart: ×2
    expect(out.zoom).toBeCloseTo(2);
    expect(out.rotate).toBe(0);
    const back = g.move(2, 170, 100); // 30 px: ×0.25
    expect(back.zoom).toBeCloseTo(0.25);
    g.up(2);
    expect(g.active).toBe(false);
  });

  it('turns a twist into single 90° steps; clockwise on screen = world clockwise = step -1', () => {
    const g = new TouchCameraGesture({ twistDeg: 40 });
    g.down(1, 0, 0);
    g.down(2, 100, 0);
    // rotate finger 2 around finger 1 by 20°: below threshold
    const at = (deg: number) => [Math.cos((deg * Math.PI) / 180) * 100, Math.sin((deg * Math.PI) / 180) * 100] as const;
    expect(g.move(2, ...at(20)).rotate).toBe(0);
    // to 45° (clockwise on a y-down screen): one step
    expect(g.move(2, ...at(45)).rotate).toBe(-1);
    // continuing to 60° is not another step yet (baseline moved to 45°)
    expect(g.move(2, ...at(60)).rotate).toBe(0);
    // twisting back counter-clockwise past the threshold: +1
    expect(g.move(2, ...at(0)).rotate).toBe(1);
  });

  it('rebases when a finger lifts and another lands (no jump)', () => {
    const g = new TouchCameraGesture();
    g.down(1, 0, 0);
    g.down(2, 100, 0);
    g.down(3, 0, 300);
    g.up(2); // now fingers 1 and 3, 300 px apart, vertical
    const out = g.move(3, 0, 300);
    expect(out.zoom).toBe(1);
    expect(out.rotate).toBe(0);
  });
});

describe('responsive framing and viewport insets', () => {
  const tv = Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180);

  it('portrait phones keep at least MIN_HALF_WIDTH tiles to each side', () => {
    const aspect = 390 / 844;
    const d = defaultDistance(aspect);
    expect(d * tv * aspect).toBeGreaterThanOrEqual(MIN_HALF_WIDTH - 1e-6);
    expect(d).toBeLessThanOrEqual(MAX_DIST);
  });

  it('landscape phones with a hotbar keep at least MIN_HALF_HEIGHT tiles above / below in the free area', () => {
    const safe = { w: 1, h: (390 - 90) / 390 };
    const d = defaultDistance(844 / 390, CAMERA_FOV_DEG, safe);
    expect(d * tv * safe.h).toBeGreaterThanOrEqual(MIN_HALF_HEIGHT - 1e-6);
  });

  it('desktop framing is unchanged by the minimums', () => {
    const d = defaultDistance(1280 / 800);
    expect(d * tv * 1.6).toBeCloseTo(8.5, 1);
  });

  it('insets move the follow target into the middle of the uncovered rectangle', () => {
    const rig = new CameraRig(1);
    rig.setViewport(390, 844);
    rig.follow(new THREE.Vector3(10, 0, 10), true);
    rig.settle();
    const centre = () => {
      // the look-at point (target + lookOffset) is what sits at the view centre
      const p = new THREE.Vector3(10, 0.45, 10).project(rig.camera);
      return { x: ((p.x + 1) / 2) * 390, y: ((1 - p.y) / 2) * 844 };
    };
    expect(centre().x).toBeCloseTo(195, 0);
    expect(centre().y).toBeCloseTo(422, 0);
    rig.setInsets({ top: 100, bottom: 240, left: 0, right: 40 });
    rig.settle();
    const c = centre();
    expect(c.x).toBeCloseTo((0 + (390 - 40)) / 2, 0);
    expect(c.y).toBeCloseTo((100 + (844 - 240)) / 2, 0);
    // auto-framing measures against the uncovered rectangle
    const n = rig.safeNdc();
    expect(n.top).toBeCloseTo(1 - 200 / 844);
    expect(n.bottom).toBeCloseTo(-1 + 480 / 844);
    // clearing restores the plain projection
    rig.setInsets({});
    rig.settle();
    expect(centre().y).toBeCloseTo(422, 0);
  });

  it('insets never cover more than 80% of the viewport', () => {
    const rig = new CameraRig(1);
    rig.setViewport(400, 400);
    rig.setInsets({ top: 400, bottom: 400 });
    expect(rig.safeFraction().h).toBeCloseTo(0.2);
  });

  it('a bottom hotbar zooms the default view out so the same tiles stay visible', () => {
    const rig = new CameraRig(1);
    rig.setViewport(390, 844);
    const plain = rig.userDist;
    rig.setInsets({ bottom: 200 });
    expect(rig.userDist).toBeGreaterThanOrEqual(plain);
  });

  it('distanceToFrame keeps points inside the uncovered rectangle', () => {
    const rig = new CameraRig(1);
    rig.setViewport(390, 844);
    rig.setInsets({ top: 80, bottom: 260 });
    rig.follow(new THREE.Vector3(10, 0, 10), true);
    rig.settle();
    const pts = [new THREE.Vector3(10, 0, 15), new THREE.Vector3(10, 1.7, 15)];
    const d = rig.distanceToFrame(pts, rig.userDist);
    rig.setFrameDist(d);
    rig.settle();
    const b = rig.safeNdc();
    for (const p of pts) {
      const v = p.clone().project(rig.camera);
      expect(v.y).toBeGreaterThan(b.bottom);
      expect(v.y).toBeLessThan(b.top);
    }
  });

  it('zoomBy: > 1 moves closer, < 1 further, clamped', () => {
    const rig = new CameraRig(1.6);
    rig.setZoom(16, true);
    rig.zoomBy(2);
    expect(rig.distTarget).toBeCloseTo(8);
    rig.zoomBy(0.25);
    expect(rig.distTarget).toBeCloseTo(32);
    rig.zoomBy(0.1);
    expect(rig.distTarget).toBeCloseTo(USER_MAX_DIST);
    rig.zoomBy(0);
    rig.zoomBy(Number.NaN);
    expect(rig.distTarget).toBeCloseTo(USER_MAX_DIST);
  });
});

describe('compactModel (draw-call budget for actors)', () => {
  const countMeshes = (o: THREE.Object3D) => {
    let n = 0;
    o.traverse((x) => ((x as THREE.Mesh).isMesh ? n++ : 0));
    return n;
  };
  const worldBox = (o: THREE.Object3D) => {
    o.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(o, true);
  };

  it('merges a humanoid into a few meshes and keeps its bounds and animated parts', () => {
    const m = buildModel({ archetype: 'humanoid', colors: { primary: '#884422', secondary: '#224488', accent: '#eeeecc' }, parts: [], scale: 1, idle: 'bob' }, { lights: false });
    const before = countMeshes(m);
    const box0 = worldBox(m);
    const anim0: string[] = [];
    m.traverse((o) => o.userData.anim && anim0.push(o.userData.anim.kind));
    compactModel(m);
    const after = countMeshes(m);
    expect(after).toBeLessThan(before);
    const box1 = worldBox(m);
    expect(box1.min.distanceTo(box0.min)).toBeLessThan(1e-3);
    expect(box1.max.distanceTo(box0.max)).toBeLessThan(1e-3);
    const anim1: string[] = [];
    m.traverse((o) => o.userData.anim && anim1.push(o.userData.anim.kind));
    expect(anim1.sort()).toEqual(anim0.sort());
    // animation still runs and moves the merged arm geometry
    expect(() => animateModel(m, 1.2, { walk: 0.3 })).not.toThrow();
  });

  it('merges different colours into one vertex-coloured mesh per rigid node when asked', () => {
    const root = new THREE.Group();
    const a = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.9 });
    const b = new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.3, metalness: 0.5, flatShading: true });
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), a);
    const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), b);
    m2.position.set(2, 0, 0);
    root.add(m1, m2);
    const vc = new THREE.MeshStandardMaterial({ vertexColors: true });
    const removed = compactModel(root, { colorClass: () => 'std', vertexColorMaterial: () => vc });
    expect(removed).toBe(1);
    expect(countMeshes(root)).toBe(1);
    const mesh = root.children[0] as THREE.Mesh;
    expect(mesh.material).toBe(vc);
    const g = mesh.geometry;
    const color = g.getAttribute('color');
    const rough = g.getAttribute('aRough');
    const metal = g.getAttribute('aMetal');
    expect(color.count).toBe(g.getAttribute('position').count);
    // first half red / rough, second half green / metallic
    expect(color.getX(0)).toBeCloseTo(1);
    expect(color.getY(color.count - 1)).toBeCloseTo(1);
    expect(rough.getX(0)).toBeCloseTo(0.9);
    expect(rough.getX(rough.count - 1)).toBeCloseTo(0.3);
    expect(metal.getX(metal.count - 1)).toBeCloseTo(0.5);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeCloseTo(2.5);
  });

  it('keeps meshes with non-mesh children (lights) and rigid meshes in place', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial();
    const lit = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    lit.add(new THREE.PointLight());
    const arm = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    arm.userData.anim = { kind: 'arm' };
    const plain1 = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    const plain2 = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    root.add(lit, arm, plain1, plain2);
    compactModel(root);
    expect(lit.parent).toBe(root);
    expect(arm.parent).toBe(root);
    expect(plain1.parent).toBeNull();
    expect(plain2.parent).toBeNull();
    expect(countMeshes(root)).toBe(3);
  });
});

describe('quality budgets on the light rig and backdrop', () => {
  it('hides lights beyond the budget and toggles sun shadows', () => {
    const rig = new LightRig();
    const scene = new THREE.Scene();
    rig.configure({ ambient: '#808080', ambientIntensity: 0.5, sun: { color: '#ffffff', intensity: 1, elevation: 50 }, lamps: { color: '#ffcc88', intensity: 1 } } as never, scene);
    rig.setBudget({ lamps: 4, models: 1, shadows: false, shadowMapSize: 1024 });
    expect(rig.lamps.filter((l) => l.visible).length).toBe(4);
    expect(rig.models.filter((l) => l.visible).length).toBe(1);
    expect(rig.sun.castShadow).toBe(false);
    expect(rig.sun.shadow.mapSize.x).toBe(1024);
    // a lamp beyond the budget never shines
    const lamps = Array.from({ length: 8 }, (_, i) => ({ tile: i, pos: new THREE.Vector3(i, 1, 0), color: '#fff', phase: 0, flicker: 1, visible: true }));
    rig.update(0, new THREE.Vector3(), new THREE.Vector3(0, 10, 10), lamps as never, []);
    expect(rig.lamps.slice(4).every((l) => l.intensity === 0)).toBe(true);
    expect(rig.lamps[0].intensity).toBeGreaterThan(0);
    rig.setBudget({ lamps: LAMP_LIGHTS, models: MODEL_LIGHTS, shadows: true, shadowMapSize: 2048 });
    expect(rig.sun.castShadow).toBe(true);
    expect(rig.liveLights).toBe(1 + LAMP_LIGHTS + MODEL_LIGHTS);
  });

  it('backdrop detail sets the shader octaves and dome segments', () => {
    const b = new Backdrop();
    b.setDetail(3, 24);
    expect(b.octaves).toBe(3);
    expect((b.mesh.geometry as THREE.SphereGeometry).parameters.widthSegments).toBe(24);
    b.setDetail(99, 48);
    expect(b.octaves).toBe(5);
    b.dispose();
  });
});
