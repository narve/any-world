import { describe, it, expect } from 'vitest';
import { createRng, rngFromState, SeededRng } from '../../src/engine/rng';
import { computeFov, hasLos } from '../../src/engine/fov';
import { findPath, bfsDistances } from '../../src/engine/path';
import { line } from '../../src/engine/util';

describe('rng (sfc32)', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    const sc = Array.from({ length: 20 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });

  it('state round-trips mid-sequence', () => {
    const a = createRng(7);
    for (let i = 0; i < 13; i++) a.next();
    const st = a.state();
    expect(st).toHaveLength(4);
    const b = rngFromState(st);
    expect(Array.from({ length: 10 }, () => a.u32())).toEqual(Array.from({ length: 10 }, () => b.u32()));
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
  });

  it('int/dice/pick/chance/weighted stay in bounds', () => {
    const r = createRng(1);
    for (let i = 0; i < 2000; i++) {
      const n = r.int(-3, 5);
      expect(Number.isInteger(n) && n >= -3 && n <= 5).toBe(true);
      const d = r.dice('2d6');
      expect(d >= 2 && d <= 12).toBe(true);
      expect(['a', 'b']).toContain(r.pick(['a', 'b']));
    }
    expect(r.int(5, 5)).toBe(5);
    expect(r.int(5, 1)).toBeGreaterThanOrEqual(1);
    expect(r.dice('nonsense')).toBe(0);
    expect(r.chance(0)).toBe(false);
    expect(r.chance(1)).toBe(true);
    expect(r.weighted([0, 0])).toBe(-1);
    for (let i = 0; i < 100; i++) expect(r.weighted([0, 3, 0])).toBe(1);
    expect(() => r.pick([])).toThrow();
    expect(() => new SeededRng([1, 2])).toThrow();
  });

  it('every int value is reachable (roughly uniform)', () => {
    const r = createRng(9);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) counts[r.int(1, 6) - 1]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });

  it('shuffle is a permutation', () => {
    const r = createRng(3);
    const arr = [1, 2, 3, 4, 5, 6, 7];
    expect([...r.shuffle([...arr])].sort()).toEqual(arr);
  });
});

function grid(rows: string[]) {
  const h = rows.length;
  const w = rows[0].length;
  const opaque = (x: number, y: number) => rows[y]?.[x] === '#';
  return { w, h, opaque };
}

describe('fov (symmetric shadowcasting)', () => {
  it('sees an open room and not through walls', () => {
    const g = grid(['#########', '#.......#', '#...#...#', '#.......#', '#########']);
    const vis = computeFov(g.w, g.h, { x: 2, y: 2 }, 10, g.opaque);
    expect(vis.has(2 * g.w + 2)).toBe(true);
    expect(vis.has(1 * g.w + 3)).toBe(true);
    expect(vis.has(3 * g.w + 5)).toBe(true);
    expect(vis.has(3 * g.w + 7)).toBe(false); // in the pillar's shadow
    expect(vis.has(2 * g.w + 4)).toBe(true); // the wall itself is visible
    expect(vis.has(2 * g.w + 6)).toBe(false); // directly behind the pillar
  });

  it('respects the radius', () => {
    const g = grid(Array.from({ length: 21 }, () => '.'.repeat(21)));
    const vis = computeFov(g.w, g.h, { x: 10, y: 10 }, 3, g.opaque);
    for (const i of vis) {
      const x = i % g.w;
      const y = Math.floor(i / g.w);
      expect((x - 10) ** 2 + (y - 10) ** 2).toBeLessThanOrEqual(12);
    }
    expect(vis.has(10 * g.w + 13)).toBe(true);
    expect(vis.has(10 * g.w + 14)).toBe(false);
  });

  it('is symmetric between floor tiles on random maps', () => {
    const r = createRng(5);
    for (let trial = 0; trial < 8; trial++) {
      const w = 16;
      const h = 12;
      const walls = new Set<number>();
      for (let i = 0; i < w * h; i++) if (r.chance(0.25)) walls.add(i);
      const opaque = (x: number, y: number) => walls.has(y * w + x);
      const floors: { x: number; y: number }[] = [];
      for (let i = 0; i < w * h; i++) if (!walls.has(i)) floors.push({ x: i % w, y: Math.floor(i / w) });
      const fovs = new Map<number, Set<number>>();
      for (const f of floors) fovs.set(f.y * w + f.x, computeFov(w, h, f, 30, opaque));
      for (const a of floors)
        for (const b of floors) {
          const ia = a.y * w + a.x;
          const ib = b.y * w + b.x;
          expect(fovs.get(ia)!.has(ib)).toBe(fovs.get(ib)!.has(ia));
        }
    }
  });

  it('hasLos is symmetric and blocked by walls', () => {
    const g = grid(['.....', '..#..', '.....']);
    expect(hasLos({ x: 0, y: 1 }, { x: 4, y: 1 }, g.opaque)).toBe(false);
    expect(hasLos({ x: 0, y: 0 }, { x: 4, y: 0 }, g.opaque)).toBe(true);
    expect(hasLos({ x: 1, y: 1 }, { x: 1, y: 1 }, g.opaque)).toBe(true);
  });

  it('line includes both endpoints', () => {
    const l = line({ x: 0, y: 0 }, { x: 3, y: 1 });
    expect(l[0]).toEqual({ x: 0, y: 0 });
    expect(l[l.length - 1]).toEqual({ x: 3, y: 1 });
  });
});

describe('path', () => {
  const g = grid(['..........', '.########.', '.#......#.', '.#..##..#.', '..........']);
  const pass = (x: number, y: number) => !g.opaque(x, y);

  it('finds a shortest 8-dir path around walls', () => {
    const p = findPath(g.w, g.h, { x: 0, y: 0 }, { x: 9, y: 4 }, pass)!;
    expect(p).not.toBeNull();
    expect(p[p.length - 1]).toEqual({ x: 9, y: 4 });
    for (let i = 1; i < p.length; i++) {
      expect(Math.max(Math.abs(p[i].x - p[i - 1].x), Math.abs(p[i].y - p[i - 1].y))).toBe(1);
      expect(pass(p[i].x, p[i].y)).toBe(true);
    }
    expect(p.length).toBe(12);
  });

  it('returns null when unreachable and [] when already there', () => {
    const closed = grid(['.#.', '###', '...']);
    expect(findPath(3, 3, { x: 0, y: 0 }, { x: 2, y: 2 }, (x, y) => !closed.opaque(x, y))).toBeNull();
    expect(findPath(3, 3, { x: 0, y: 0 }, { x: 0, y: 0 }, () => true)).toEqual([]);
  });

  it('can treat an occupied goal as passable', () => {
    const p = findPath(3, 1, { x: 0, y: 0 }, { x: 2, y: 0 }, (x) => x !== 2, { goalAlwaysPassable: true });
    expect(p).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('bfs distances', () => {
    const d = bfsDistances(g.w, g.h, { x: 0, y: 0 }, pass);
    expect(d[0]).toBe(0);
    expect(d[4 * g.w + 9]).toBe(12);
    expect(d[1 * g.w + 1]).toBe(-1);
  });
});
