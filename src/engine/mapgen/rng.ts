/**
 * Small seeded RNG (sfc32) implementing the engine `Rng` contract. Used by mapgen tests and the
 * mapgen-ascii tool; the engine proper passes its own state-backed Rng into generateArea.
 */
import type { Rng } from '../types';

export function seededRng(seed: number): Rng {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = (seed >>> 0) ^ 0xdeadbeef;
  const next32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 15; i++) next32();
  const rng: Rng = {
    next: () => next32() / 4294967296,
    int: (min, max) => min + Math.floor(rng.next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(rng.next() * arr.length)],
    chance: (p) => rng.next() < p,
    dice: (spec) => {
      const m = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(spec);
      if (!m) {
        const n = Number(spec);
        return Number.isFinite(n) ? n : 0;
      }
      const count = m[1] ? Number(m[1]) : 1;
      const sides = Number(m[2]);
      let total = m[3] ? Number(m[3].replace(/\s+/g, '')) : 0;
      for (let i = 0; i < count; i++) total += rng.int(1, sides);
      return total;
    },
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
  return rng;
}
