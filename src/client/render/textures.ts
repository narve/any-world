/**
 * Procedural canvas textures for SurfaceStyle patterns. Colours are baked in (base `color`, detail
 * `color2`), so materials using them stay white and per-instance colours act as light/fog multipliers.
 * Returns null outside the browser (unit tests) — callers fall back to flat colours.
 */
import * as THREE from 'three';
import { shade, mixHex } from './color';

export type Pattern =
  | 'plain'
  | 'tiles'
  | 'planks'
  | 'grass'
  | 'metal_plates'
  | 'cobble'
  | 'carpet'
  | 'sand'
  | 'water'
  | 'snow'
  // future/abstract patterns (accepted if the schema grows them)
  | 'grid'
  | 'lines'
  | 'noise'
  | 'gradient'
  | 'none';

const SIZE = 128;
const cache = new Map<string, THREE.CanvasTexture>();

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function hasCanvas(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

export function patternTexture(pattern: string, color: string, color2?: string, seed = 7): THREE.CanvasTexture | null {
  if (!hasCanvas()) return null;
  const key = `${pattern}|${color}|${color2 ?? ''}|${seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, pattern as Pattern, color, color2 ?? shade(color, 0.8), rng(seed * 9973 + pattern.length));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  cache.set(key, tex);
  return tex;
}

export function clearTextureCache(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
  for (const t of glowCache.values()) t.dispose();
  glowCache.clear();
}

function speckle(ctx: CanvasRenderingContext2D, r: () => number, color: string, n: number, size: number, alpha: number) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) ctx.fillRect(r() * SIZE, r() * SIZE, size * (0.5 + r()), size * (0.5 + r()));
  ctx.globalAlpha = 1;
}

function draw(ctx: CanvasRenderingContext2D, pattern: Pattern, c1: string, c2: string, r: () => number): void {
  const S = SIZE;
  ctx.fillStyle = c1;
  ctx.fillRect(0, 0, S, S);
  switch (pattern) {
    case 'tiles': {
      const n = 2;
      const t = S / n;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          ctx.fillStyle = (x + y) % 2 ? c1 : mixHex(c1, c2, 0.35);
          ctx.fillRect(x * t + 2, y * t + 2, t - 4, t - 4);
          ctx.fillStyle = shade(c1, 1.08);
          ctx.fillRect(x * t + 4, y * t + 4, t - 8, 3);
        }
      ctx.strokeStyle = shade(c2, 0.7);
      ctx.lineWidth = 3;
      for (let i = 0; i <= n; i++) {
        ctx.beginPath();
        ctx.moveTo(i * t, 0);
        ctx.lineTo(i * t, S);
        ctx.moveTo(0, i * t);
        ctx.lineTo(S, i * t);
        ctx.stroke();
      }
      speckle(ctx, r, shade(c1, 0.85), 80, 2, 0.25);
      break;
    }
    case 'planks': {
      const rows = 4;
      const h = S / rows;
      for (let i = 0; i < rows; i++) {
        const base = i % 2 ? c1 : mixHex(c1, c2, 0.5);
        ctx.fillStyle = shade(base, 0.92 + r() * 0.16);
        ctx.fillRect(0, i * h, S, h);
        // grain
        ctx.strokeStyle = shade(base, 0.78);
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        for (let g = 0; g < 4; g++) {
          const y = i * h + 4 + r() * (h - 8);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.bezierCurveTo(S * 0.3, y + (r() - 0.5) * 4, S * 0.6, y + (r() - 0.5) * 4, S, y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // seams & butt joints
        ctx.fillStyle = shade(c2, 0.5);
        ctx.fillRect(0, i * h, S, 2);
        const jx = ((i * 0.37 + r() * 0.3) % 1) * S;
        ctx.fillRect(jx, i * h, 2, h);
        ctx.fillStyle = shade(c2, 0.4);
        ctx.fillRect(jx + 6, i * h + h / 2 - 1, 2, 2);
      }
      break;
    }
    case 'grass': {
      speckle(ctx, r, mixHex(c1, c2, 0.5), 300, 3, 0.5);
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 420; i++) {
        const x = r() * S;
        const y = r() * S;
        ctx.strokeStyle = r() > 0.5 ? shade(c1, 1.2) : shade(c2, 0.85);
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (r() - 0.5) * 4, y - 3 - r() * 5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'metal_plates': {
      const n = 2;
      const t = S / n;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const px = x * t;
          const py = y * t;
          ctx.fillStyle = shade(c1, 0.95 + ((x + y) % 2) * 0.08);
          ctx.fillRect(px, py, t, t);
          ctx.fillStyle = shade(c1, 1.18);
          ctx.fillRect(px, py, t, 2);
          ctx.fillRect(px, py, 2, t);
          ctx.fillStyle = shade(c2, 0.55);
          ctx.fillRect(px, py + t - 2, t, 2);
          ctx.fillRect(px + t - 2, py, 2, t);
          ctx.fillStyle = shade(c2, 1.1);
          for (const [rx, ry] of [[6, 6], [t - 8, 6], [6, t - 8], [t - 8, t - 8]]) {
            ctx.beginPath();
            ctx.arc(px + rx + 1, py + ry + 1, 2, 0, Math.PI * 2);
            ctx.fill();
          }
          // diamond tread on alternate plates
          if ((x + y) % 2 === 0) {
            ctx.strokeStyle = shade(c1, 1.12);
            ctx.globalAlpha = 0.45;
            for (let k = 10; k < t - 10; k += 9)
              for (let m = 10; m < t - 10; m += 9) {
                ctx.beginPath();
                ctx.moveTo(px + k, py + m + 3);
                ctx.lineTo(px + k + 4, py + m);
                ctx.stroke();
              }
            ctx.globalAlpha = 1;
          }
        }
      break;
    }
    case 'cobble': {
      ctx.fillStyle = shade(c2, 0.55);
      ctx.fillRect(0, 0, S, S);
      const cells = 5;
      const t = S / cells;
      for (let y = 0; y < cells; y++)
        for (let x = 0; x < cells; x++) {
          const cx = x * t + t / 2 + (r() - 0.5) * t * 0.25 + (y % 2) * t * 0.3;
          const cy = y * t + t / 2 + (r() - 0.5) * t * 0.25;
          const rx = t * (0.38 + r() * 0.08);
          const ry = t * (0.36 + r() * 0.08);
          const fill = mixHex(c1, c2, r() * 0.6);
          for (const ox of [-S, 0, S]) {
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.ellipse(cx + ox, cy, rx, ry, r(), 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = shade(fill, 1.15);
            ctx.beginPath();
            ctx.ellipse(cx + ox - rx * 0.2, cy - ry * 0.25, rx * 0.5, ry * 0.35, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      break;
    }
    case 'carpet': {
      ctx.fillStyle = c1;
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = c2;
      ctx.lineWidth = 5;
      ctx.strokeRect(10, 10, S - 20, S - 20);
      ctx.fillStyle = mixHex(c1, c2, 0.5);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const x = 24 + i * 27;
          const y = 24 + j * 27;
          ctx.beginPath();
          ctx.moveTo(x, y - 7);
          ctx.lineTo(x + 7, y);
          ctx.lineTo(x, y + 7);
          ctx.lineTo(x - 7, y);
          ctx.closePath();
          ctx.fill();
        }
      speckle(ctx, r, shade(c1, 0.8), 500, 1, 0.3);
      break;
    }
    case 'sand': {
      speckle(ctx, r, shade(c1, 0.88), 900, 1.2, 0.45);
      speckle(ctx, r, shade(c1, 1.12), 600, 1.2, 0.45);
      ctx.strokeStyle = c2;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const y = i * (S / 5) + r() * 8;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= S; x += 16) ctx.quadraticCurveTo(x + 8, y + (r() - 0.5) * 8, x + 16, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'water': {
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, c1);
      g.addColorStop(1, mixHex(c1, c2, 0.6));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = shade(c1, 1.35);
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 9; i++) {
        const x = r() * S;
        const y = r() * S;
        ctx.beginPath();
        ctx.arc(x, y, 6 + r() * 10, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'snow': {
      speckle(ctx, r, shade(c1, 0.92), 500, 2, 0.5);
      speckle(ctx, r, '#ffffff', 160, 1.5, 0.9);
      speckle(ctx, r, c2, 60, 3, 0.25);
      break;
    }
    case 'grid': {
      ctx.strokeStyle = c2;
      ctx.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo((i * S) / 4, 0);
        ctx.lineTo((i * S) / 4, S);
        ctx.moveTo(0, (i * S) / 4);
        ctx.lineTo(S, (i * S) / 4);
        ctx.stroke();
      }
      break;
    }
    case 'lines': {
      ctx.strokeStyle = c2;
      ctx.lineWidth = 3;
      for (let i = -S; i < S * 2; i += 16) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + S, S);
        ctx.stroke();
      }
      break;
    }
    case 'noise': {
      for (let i = 0; i < 1400; i++) {
        ctx.fillStyle = mixHex(c1, c2, r());
        ctx.fillRect(Math.floor(r() * 32) * 4, Math.floor(r() * 32) * 4, 4, 4);
      }
      break;
    }
    case 'gradient': {
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      break;
    }
    case 'none':
      break;
    case 'plain':
    default: {
      speckle(ctx, r, shade(c1, 0.9), 260, 2.5, 0.35);
      speckle(ctx, r, shade(c1, 1.08), 200, 2.5, 0.35);
      ctx.strokeStyle = shade(c1, 0.82);
      ctx.globalAlpha = 0.35;
      ctx.strokeRect(1, 1, S - 2, S - 2);
      ctx.globalAlpha = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Radial glow (lamp halos, transition marker, vfx)
// ---------------------------------------------------------------------------

const glowCache = new Map<string, THREE.Texture>();

export function glowTexture(): THREE.Texture {
  const key = 'glow';
  const hit = glowCache.get(key);
  if (hit) return hit;
  let tex: THREE.Texture;
  if (hasCanvas()) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
  } else {
    tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }
  tex.needsUpdate = true;
  glowCache.set(key, tex);
  return tex;
}

/** Text sprite texture (damage numbers, labels). Caller owns & disposes it. */
export function textTexture(text: string, color: string, opts: { size?: number; outline?: string; bold?: boolean } = {}): { tex: THREE.Texture; aspect: number } | null {
  if (!hasCanvas()) return null;
  const size = opts.size ?? 48;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `${opts.bold === false ? '' : 'bold '}${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + size * 0.5;
  const h = Math.ceil(size * 1.35);
  c.width = Math.max(4, w);
  c.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size * 0.16);
  ctx.strokeStyle = opts.outline ?? 'rgba(10,10,14,0.9)';
  ctx.strokeText(text, c.width / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, aspect: c.width / h };
}
