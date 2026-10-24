/** Small colour helpers shared by the renderer (all inputs are CSS hex strings or THREE.Color). */
import * as THREE from 'three';

export function col(hex: string | undefined, fallback = '#888888'): THREE.Color {
  const c = new THREE.Color();
  try {
    c.set(hex && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex) ? hex : fallback);
  } catch {
    c.set(fallback);
  }
  return c;
}

/** Returns a hex string darkened (f<1) or lightened (f>1) in sRGB space. */
export function shade(hex: string | undefined, f: number, fallback = '#888888'): string {
  const c = col(hex, fallback);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (f < 1) hsl.l = hsl.l * f;
  else hsl.l = Math.min(1, hsl.l + (1 - hsl.l) * (f - 1));
  c.setHSL(hsl.h, hsl.s, hsl.l);
  return '#' + c.getHexString();
}

/** Mix two hex colours (t=0 → a, t=1 → b) and return hex. */
export function mixHex(a: string | undefined, b: string | undefined, t: number): string {
  const c = col(a).lerp(col(b), t);
  return '#' + c.getHexString();
}

/** Relative luminance in sRGB (0..1), cheap approximation. */
export function luminance(hex: string | undefined): number {
  const c = col(hex);
  const srgb = c.clone().convertLinearToSRGB();
  return 0.2126 * srgb.r + 0.7152 * srgb.g + 0.0722 * srgb.b;
}

/** Deterministic 0..1 hash of two ints (for per-tile colour jitter etc.). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
