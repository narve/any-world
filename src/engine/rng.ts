/**
 * Seeded PRNG (sfc32, seeded through splitmix32). The full internal state is four uint32s,
 * which is what GameState.rng stores, so a game can be saved and resumed mid-sequence.
 */
import type { Rng } from './types';

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

const DICE_RE = /^(\d{1,3})d(\d{1,4})$/;

export class SeededRng implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: readonly number[]) {
    if (!Array.isArray(state) || state.length !== 4 || state.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error('rng state must be 4 finite numbers');
    }
    this.a = state[0] >>> 0;
    this.b = state[1] >>> 0;
    this.c = state[2] >>> 0;
    this.d = state[3] >>> 0;
    if ((this.a | this.b | this.c | this.d) === 0) this.d = 1;
  }

  static fromSeed(seed: number): SeededRng {
    const sm = splitmix32(Math.floor(seed) | 0);
    const r = new SeededRng([sm(), sm(), sm(), sm()]);
    for (let i = 0; i < 12; i++) r.u32();
    return r;
  }

  /** raw 32-bit output */
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.u32() / 4294967296;
  }

  int(min: number, max: number): number {
    let lo = Math.ceil(min);
    let hi = Math.floor(max);
    if (hi < lo) [lo, hi] = [hi, lo];
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('pick from empty array');
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** always consumes exactly one draw so call sequences stay aligned */
  chance(p: number): boolean {
    const r = this.next();
    if (!(p > 0)) return false;
    if (p >= 1) return true;
    return r < p;
  }

  /** "2d6" → sum of 2 six-sided dice; invalid specs roll 0 */
  dice(spec: string): number {
    const m = DICE_RE.exec(spec.trim());
    if (!m) return 0;
    const n = Math.min(Number(m[1]), 100);
    const sides = Number(m[2]);
    if (sides < 1) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += 1 + Math.floor(this.next() * sides);
    return sum;
  }

  /** Fisher–Yates, in place; returns the same array */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** weighted pick; returns -1 when all weights are 0 */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return -1;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
    return -1;
  }

  state(): number[] {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }
}

export function createRng(seed: number): SeededRng {
  return SeededRng.fromSeed(seed);
}

export function rngFromState(state: readonly number[]): SeededRng {
  return new SeededRng(state);
}

/** parse "NdM" → [n, m] or null */
export function parseDice(spec: string | undefined): [number, number] | null {
  if (!spec) return null;
  const m = DICE_RE.exec(spec.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
