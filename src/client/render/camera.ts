/**
 * Tilted perspective camera that smoothly follows a target, orbits in animated 90° steps and zooms
 * within limits. Step 0 looks north from the south (map row 0 at the top of the screen).
 */
import * as THREE from 'three';
import { yawForStep, normStep } from './coords';

export const CAMERA_PITCH_DEG = 52;
export const MIN_DIST = 6;
export const MAX_DIST = 30;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  readonly desired = new THREE.Vector3();
  /** integer step; yaw = -step·90° */
  step = 0;
  yaw = 0;
  dist = 11.5;
  distTarget = 11.5;
  /** the distance the player chose (wheel / setZoom) */
  userDist = 11.5;
  /** minimum distance that keeps everything that must be on screen framed (0 = no constraint) */
  frameDist = 0;
  pitch = (CAMERA_PITCH_DEG * Math.PI) / 180;
  private lookOffset = new THREE.Vector3(0, 0.45, 0);

  constructor(aspect = 1) {
    this.camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 200);
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
    // an explicit zoom-in overrides auto framing until the renderer next reframes (next turn)
    if (delta < 0) this.frameDist = 0;
    this.retarget();
  }

  setZoom(dist: number, snap = false): void {
    this.userDist = Math.min(MAX_DIST, Math.max(MIN_DIST, dist));
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
   * shrunk by `margin` (NDC units) on each side, for the current target/yaw/pitch/aspect. Returns
   * MAX_DIST when even that cannot frame them all. Does not move the camera.
   */
  distanceToFrame(points: readonly THREE.Vector3[], from: number, margin = { x: 0.1, top: 0.12, bottom: 0.3 }): number {
    if (points.length === 0) return 0;
    const cam = this.camera.clone();
    const v = new THREE.Vector3();
    const fits = (d: number): boolean => {
      this.place(cam, this.desired, this.yawTarget(), d);
      for (const p of points) {
        v.copy(p).project(cam);
        if (v.z > 1 || Math.abs(v.x) > 1 - margin.x || v.y > 1 - margin.top || v.y < -1 + margin.bottom) return false;
      }
      return true;
    };
    let d = Math.max(MIN_DIST, from);
    while (d < MAX_DIST && !fits(d)) d = Math.min(MAX_DIST, d * 1.08);
    return d;
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
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** true while still moving (useful to keep rendering) */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 9);
    const yawTarget = yawForStep(this.step);
    const moving =
      this.target.distanceToSquared(this.desired) > 1e-6 || Math.abs(this.yaw - yawTarget) > 1e-4 || Math.abs(this.dist - this.distTarget) > 1e-3;
    this.target.lerp(this.desired, k);
    this.yaw += (yawTarget - this.yaw) * (1 - Math.exp(-dt * 10));
    this.dist += (this.distTarget - this.dist) * k;
    this.apply();
    return moving;
  }

  /** finish any easing immediately */
  settle(): void {
    this.target.copy(this.desired);
    this.yaw = yawForStep(this.step);
    this.dist = this.distTarget;
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
