/**
 * Backdrop: what is drawn beyond the map and through void tiles (AreaPlan.backdrop).
 *
 * A large inside-out sphere follows the camera and is drawn first, without depth, fog or tone
 * mapping, so nothing in the scene can be hidden by it and fog never washes it out. A fragment shader
 * draws one of the backdrop styles from the view direction:
 *
 *   color      flat colour with a soft vignette
 *   gradient   color → color2 across the view (slow drift)
 *   starfield  dark base, three layers of twinkling stars, faint nebula in color2
 *   clouds     a sea of soft clouds far below the map (parallax with the camera)
 *   abyss      darkness deepening downwards, drifting motes rising in color2
 *   aurora     dark base with moving curtains of color / color2
 *   grid       an endless glowing grid on a plane far below (parallax), color2 lines
 *   noise      animated, slowly churning value noise between color and color2
 *
 * Styles that live "below" the map (clouds, abyss motes, grid) are projected onto a virtual plane well
 * under the floor, so they slide past as the camera follows the player and read as depth. Nothing
 * assumes a sky or a ground: the plane is only a drawing aid for the void.
 *
 * `intensity` (0..1) scales detail and animation speed; reduce-motion freezes the animation (a still
 * frame of the same picture).
 *
 * When the plan has no backdrop, the old behaviour stays: scene.background = a solid colour derived
 * from lighting.sky / fog / ambient (see LightRig.configure) and the dome is hidden.
 */
import * as THREE from 'three';
import type { AreaPlan } from '../../schema/world';
import { col, shade, mixHex, luminance } from './color';

export type BackdropStyle = 'color' | 'gradient' | 'starfield' | 'clouds' | 'abyss' | 'aurora' | 'grid' | 'noise';
export const BACKDROP_STYLES: readonly BackdropStyle[] = ['color', 'gradient', 'starfield', 'clouds', 'abyss', 'aurora', 'grid', 'noise'];

export interface BackdropParams {
  style: BackdropStyle;
  styleIndex: number;
  color: string;
  color2: string;
  intensity: number;
}

type BackdropSpec = NonNullable<AreaPlan['backdrop']>;

/**
 * Resolved shader parameters for a backdrop spec (pure; unit tested). A missing color2 is derived
 * from color so every style has two usable tones: lighter for dark bases (stars, grid lines, motes),
 * darker for light ones (gradients, clouds).
 */
export function backdropParams(spec: BackdropSpec): BackdropParams {
  const style: BackdropStyle = BACKDROP_STYLES.includes(spec.style as BackdropStyle) ? (spec.style as BackdropStyle) : 'color';
  const color = spec.color;
  const dark = luminance(color) < 0.35;
  let color2 = spec.color2;
  if (!color2) {
    if (style === 'starfield' || style === 'grid' || style === 'abyss' || style === 'aurora') color2 = dark ? mixHex(shade(color, 2.2), '#ffffff', 0.45) : shade(color, 0.35);
    else color2 = dark ? shade(color, 1.5) : shade(color, 0.7);
  }
  const intensity = Math.max(0, Math.min(1, spec.intensity ?? 0.5));
  return { style, styleIndex: BACKDROP_STYLES.indexOf(style), color, color2, intensity };
}

/** Colour fog should take so that geometry fading out at the map edge melts into the backdrop. */
export function backdropHorizonColor(p: BackdropParams): string {
  switch (p.style) {
    case 'starfield':
    case 'abyss':
      return shade(p.color, 0.5);
    case 'gradient':
    case 'clouds':
    case 'noise':
      return mixHex(p.color, p.color2, 0.35);
    case 'aurora':
      return shade(p.color, 0.6);
    default:
      return p.color;
  }
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform int uStyle;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uIntensity;
uniform float uTime;
uniform vec3 uCam;
uniform float uPlane;

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i), n100 = hash31(i + vec3(1,0,0)), n010 = hash31(i + vec3(0,1,0)), n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1)), n101 = hash31(i + vec3(1,0,1)), n011 = hash31(i + vec3(0,1,1)), n111 = hash31(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
// stars in one layer of 3D cells on the unit sphere
float stars(vec3 d, float scale, float density, float t, float tw) {
  vec3 p = d * scale;
  vec3 c = floor(p);
  float h = hash31(c);
  if (h > density) return 0.0;
  vec3 o = vec3(hash31(c + 11.1), hash31(c + 23.7), hash31(c + 37.3)) * 0.6 + 0.2;
  float r = length(fract(p) - o);
  float b = smoothstep(0.16, 0.0, r) + 0.35 * smoothstep(0.5, 0.0, r) * smoothstep(0.08, 0.0, r * 0.5);
  float tw2 = 1.0 - tw * 0.55 * (0.5 + 0.5 * sin(t * (1.5 + h * 9.0) + h * 80.0));
  return b * tw2 * (0.55 + 0.45 * fract(h * 57.0));
}
// where a view ray meets the plane far below the map (world xz) and how far away that is
vec3 planeHit(vec3 d) {
  float down = max(0.04, -d.y);
  float t = (uCam.y - uPlane) / down;
  return vec3(uCam.xz + d.xz * t, t);
}

void main() {
  vec3 d = normalize(vDir);
  float I = uIntensity;
  float t = uTime;
  vec3 c1 = uColor;
  vec3 c2 = uColor2;
  vec3 col = c1;
  // 0 at the horizon, 1 straight down
  float down = clamp(-d.y, 0.0, 1.0);
  if (uStyle == 0) {
    // color
    col = mix(c1, c1 * 0.78, smoothstep(0.2, 1.0, down) * 0.6);
  } else if (uStyle == 1) {
    // gradient
    float az = atan(d.z, d.x);
    float g = smoothstep(-0.15, 1.0, down) + 0.12 * sin(az * 2.0 + t * 0.15) * (0.4 + I);
    col = mix(c1, c2, clamp(g, 0.0, 1.0));
    col *= 0.94 + 0.06 * fbm(d * 2.5 + vec3(0.0, t * 0.03, 0.0));
  } else if (uStyle == 2) {
    // starfield
    vec3 base = c1 * (0.55 + 0.45 * (1.0 - down));
    float neb = fbm(d * 2.2 + vec3(3.0, 1.0, t * 0.01));
    base += c2 * pow(smoothstep(0.45, 0.85, neb), 2.0) * (0.10 + 0.22 * I);
    float tw = 0.2 + 0.8 * I;
    float s = stars(d, 70.0, 0.08 + 0.10 * I, t, tw) + stars(d, 140.0, 0.10 + 0.12 * I, t * 1.3, tw) * 0.7 + stars(d, 32.0, 0.05, t * 0.7, tw) * 1.2;
    vec3 starCol = mix(vec3(1.0), c2, 0.35);
    col = base + starCol * s;
  } else if (uStyle == 3) {
    // clouds below the map
    vec3 h = planeHit(d);
    vec2 q = h.xy * 0.045;
    float drift = t * (0.02 + 0.06 * I);
    float n = fbm(vec3(q + vec2(drift, drift * 0.4), t * 0.01));
    float n2 = fbm(vec3(q * 2.3 - vec2(drift * 1.7, 0.0), 5.0 + t * 0.02));
    float cl = smoothstep(0.35, 0.75, n * 0.7 + n2 * 0.4);
    vec3 under = mix(c2, c1, 0.25);
    col = mix(under, mix(c1, vec3(1.0), 0.18), cl);
    // fade the far distance into a hazy horizon
    float far = smoothstep(60.0, 220.0, h.z);
    col = mix(col, mix(c1, c2, 0.4), far);
  } else if (uStyle == 4) {
    // abyss: darkness straight down, rising motes
    float depth = smoothstep(0.0, 0.95, down);
    col = mix(c1, c1 * 0.06, depth);
    float sw = fbm(d * 3.0 + vec3(0.0, t * 0.02, t * 0.01));
    col += c2 * 0.10 * smoothstep(0.5, 0.9, sw) * (1.0 - depth * 0.5);
    vec3 h = planeHit(d);
    vec2 g = h.xy * 0.35 + vec2(0.0, -t * (0.15 + 0.6 * I));
    vec2 cell = floor(g);
    float r = hash21(cell);
    if (r < 0.06 + 0.10 * I) {
      vec2 o = vec2(hash21(cell + 7.1), hash21(cell + 3.3)) * 0.7 + 0.15;
      float m = smoothstep(0.12, 0.0, length(fract(g) - o));
      m *= 0.55 + 0.45 * sin(t * (1.0 + r * 8.0) + r * 40.0);
      col += c2 * m * (1.0 - smoothstep(30.0, 140.0, h.z)) * 0.9;
    }
  } else if (uStyle == 5) {
    // aurora
    float az = atan(d.z, d.x);
    col = c1 * (0.35 + 0.25 * (1.0 - down));
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float wave = sin(az * (2.0 + fk) + t * (0.05 + 0.12 * I) * (1.0 + fk * 0.5) + fk * 2.1) * 0.25;
      float n = fbm(vec3(az * 1.5 + fk * 7.0, t * 0.04, fk));
      float v = (-d.y) * 2.2 + wave + n * 0.6 - 0.5 - fk * 0.35;
      float band = exp(-pow(v * (5.0 - fk), 2.0));
      float ray = 0.6 + 0.4 * sin(az * 60.0 + n * 12.0 + t * 0.4 * I);
      vec3 ac = mix(c2, mix(c2, c1 * 2.0 + 0.2, 0.5), fk / 2.0);
      col += ac * band * ray * (0.45 + 0.5 * I) / (1.0 + fk * 0.6);
    }
  } else if (uStyle == 6) {
    // grid on a plane far below
    vec3 h = planeHit(d);
    vec2 p = h.xy * 0.5;
    vec2 fw = max(fwidth(p), vec2(1e-4));
    vec2 gl = abs(fract(p - 0.5) - 0.5) / fw;
    float line = 1.0 - min(min(gl.x, gl.y), 1.0);
    vec2 p4 = p / 4.0;
    vec2 fw4 = max(fwidth(p4), vec2(1e-4));
    vec2 gl4 = abs(fract(p4 - 0.5) - 0.5) / fw4;
    float major = 1.0 - min(min(gl4.x, gl4.y), 1.0);
    float fade = 1.0 - smoothstep(25.0, 160.0, h.z);
    float pulse = 0.75 + 0.25 * sin(length(h.xy - uCam.xz) * 0.25 - t * (0.6 + 1.6 * I));
    col = mix(c1 * 0.7, c1, 1.0 - down);
    col += c2 * (line * 0.45 + major * 0.8) * fade * pulse;
    col = mix(col, c1, smoothstep(0.92, 1.0, 1.0 - down) * 0.5);
  } else {
    // noise
    vec3 q = d * (3.0 + 3.0 * I) + vec3(0.0, 0.0, t * (0.04 + 0.12 * I));
    float n = fbm(q);
    float n2 = fbm(q * 1.7 + n * 2.0);
    col = mix(c1, c2, smoothstep(0.25, 0.8, n2));
    col += (hash31(floor(d * 900.0) + floor(t * 12.0 * I)) - 0.5) * 0.04 * I;
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <colorspace_fragment>
}
`;

export class Backdrop {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  params: BackdropParams | null = null;
  /** freeze the animation (reduce motion) */
  reduceMotion = false;
  private time = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uStyle: { value: 0 },
        uColor: { value: new THREE.Color() },
        uColor2: { value: new THREE.Color() },
        uIntensity: { value: 0.5 },
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uPlane: { value: -14 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    this.material.userData.owned = true;
    const geo = new THREE.SphereGeometry(100, 48, 24);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'backdrop';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.visible = false;
    this.mesh.userData.noDim = true;
  }

  /** Set up for an area. Returns the colour scene.background should use (also when hidden). */
  configure(spec: AreaPlan['backdrop'] | undefined | null): string | null {
    if (!spec) {
      this.params = null;
      this.mesh.visible = false;
      return null;
    }
    const p = backdropParams(spec);
    this.params = p;
    const u = this.material.uniforms;
    u.uStyle.value = p.styleIndex;
    (u.uColor.value as THREE.Color).copy(col(p.color));
    (u.uColor2.value as THREE.Color).copy(col(p.color2));
    u.uIntensity.value = p.intensity;
    this.mesh.visible = true;
    return p.color;
  }

  /** Follow the camera and advance the animation. */
  update(dt: number, camera: THREE.Camera): void {
    if (!this.params) return;
    if (!this.reduceMotion) this.time += dt;
    this.mesh.position.copy(camera.position);
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    (u.uCam.value as THREE.Vector3).copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
