/**
 * Ship: a long hull (blunt stern, tapering bow) with a central longitudinal corridor broken by
 * bulkhead doors; compartments on both sides mirrored (mostly) across the keel line, an engine
 * room aft, a bridge forward, and deep sections split into inner cabins and outer holds.
 */
import { bySize, type GenContext } from '../context';

export function genShip(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const x0 = 1 + rng.int(0, 1);
  const x1 = g.w - 2;
  const len = x1 - x0 + 1;
  const cy = Math.floor(g.h / 2);
  const halfMax = Math.min(cy - 1, g.h - 2 - cy) - rng.int(0, 1);
  const bowStartT = 0.6 + rng.next() * 0.1;
  const half = (x: number): number => {
    const t = (x - x0) / (len - 1);
    if (t < 0.04) return halfMax - 2;
    if (t < 0.08) return halfMax - 1;
    if (t <= bowStartT) return halfMax;
    const u = (t - bowStartT) / (1 - bowStartT);
    return Math.max(1, Math.round(halfMax * (1 - Math.pow(u, 1.7))));
  };
  const inHull = (x: number, y: number) => x >= x0 && x <= x1 && Math.abs(y - cy) <= half(x);
  /** strictly inside the hull plating */
  const interior = (x: number, y: number) =>
    inHull(x, y) && inHull(x - 1, y) && inHull(x + 1, y) && inHull(x, y - 1) && inHull(x, y + 1);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (inHull(x, y)) g.set(x, y, 'wall');

  const symmetry = ctx.param('symmetry', 0.8, 0, 1);
  const cw = Math.round(ctx.param('corridorWidth', bySize(size, 1, 1, 3), 1, 3)) === 1 ? 1 : 3;
  const k = (cw - 1) / 2;
  const cTop = cy - k; // first corridor row
  const cBot = cy + k;

  // longitudinal layout: engine room | sections ... | bridge
  const sternWall = x0 + rng.int(5, 7);
  let bowWall = x0 + Math.floor(len * (0.8 + rng.next() * 0.05));
  // bridge needs interior space; walk aft until the hull is tall enough
  while (bowWall > sternWall + 8 && half(bowWall + 2) < 2) bowWall--;
  const bulkheads: number[] = [sternWall];
  let bx = sternWall;
  for (;;) {
    const step = rng.int(6, 9);
    if (bowWall - (bx + step) < 5) break;
    bx += step;
    bulkheads.push(bx);
  }
  bulkheads.push(bowWall);

  // engine room & bridge
  const carveSpan = (xa: number, xb: number, id: number) => {
    for (let x = xa; x <= xb; x++) for (let y = 0; y < g.h; y++) if (interior(x, y)) g.set(x, y, 'floor', id);
  };
  carveSpan(x0, sternWall - 1, g.newRegion());
  carveSpan(bowWall + 1, x1, g.newRegion());

  // corridor + bulkhead doors
  const corridor = g.newRegion();
  for (let x = sternWall; x <= bowWall; x++) {
    for (let y = cTop; y <= cBot; y++) {
      if (!interior(x, y)) continue;
      if (bulkheads.includes(x)) g.set(x, y, y === cy ? 'door' : 'wall', null);
      else g.set(x, y, 'floor', corridor);
    }
  }

  // compartments on each side of the corridor, per section
  for (let s = 0; s + 1 < bulkheads.length; s++) {
    const a = bulkheads[s];
    const b = bulkheads[s + 1];
    const inner = b - a - 1;
    const splitAt = inner >= 7 && rng.chance(0.45) ? a + 1 + rng.int(3, inner - 4) : -1;
    const depth = halfMax - k - 2; // rows between corridor wall and hull plating (approx.)
    const deepSplit = depth >= 9 && rng.chance(0.75) ? rng.int(4, 6) : 0;
    const mirrored = rng.chance(symmetry);
    const doorPicks: number[] = [];
    for (const side of [-1, 1] as const) {
      const useMirror = side === 1 && mirrored;
      const corrWallY = side === -1 ? cTop - 1 : cBot + 1;
      const split = useMirror ? splitAt : side === 1 && inner >= 7 && rng.chance(0.45) ? a + 1 + rng.int(3, inner - 4) : side === -1 ? splitAt : -1;
      const deep = useMirror ? deepSplit : side === 1 ? (depth >= 9 && rng.chance(0.75) ? rng.int(4, 6) : 0) : deepSplit;
      const spans: [number, number][] = split > 0 ? [[a + 1, split - 1], [split + 1, b - 1]] : [[a + 1, b - 1]];
      spans.forEach(([xa, xb], si) => {
        // inner cabin rows (adjacent to corridor) and optional outer hold beyond a wall line
        const innerFar = deep ? corrWallY + side * deep : corrWallY + side * 100;
        const cabin = g.newRegion();
        const cabinTiles: [number, number][] = [];
        for (let x = xa; x <= xb; x++)
          for (let y = corrWallY + side; side === -1 ? y > innerFar : y < innerFar; y += side) {
            if (!interior(x, y)) break;
            g.set(x, y, 'floor', cabin);
            cabinTiles.push([x, y]);
          }
        if (!cabinTiles.length) return;
        // door into the corridor
        const opts: number[] = [];
        for (let x = xa; x <= xb; x++) if (g.kind(x, corrWallY + side) === 'floor' && g.kind(x, corrWallY - side) === 'floor') opts.push(x);
        if (opts.length) {
          const pickIdx = side === -1 || !useMirror ? -1 : doorPicks[si] ?? -1;
          const dx = pickIdx >= 0 && opts.includes(pickIdx) ? pickIdx : opts[rng.int(0, opts.length - 1)];
          if (side === -1) doorPicks[si] = dx;
          g.set(dx, corrWallY, 'door', null);
        }
        if (deep) {
          const hold = g.newRegion();
          let any = false;
          for (let x = xa; x <= xb; x++)
            for (let y = innerFar + side; ; y += side) {
              if (!interior(x, y)) break;
              g.set(x, y, 'floor', hold);
              any = true;
            }
          if (any) {
            const hOpts: number[] = [];
            for (let x = xa; x <= xb; x++) if (g.kind(x, innerFar - side) === 'floor' && g.kind(x, innerFar + side) === 'floor') hOpts.push(x);
            if (hOpts.length) g.set(hOpts[rng.int(0, hOpts.length - 1)], innerFar, 'door', null);
          }
        }
      });
    }
  }
  // bridge and engine-room hatches on the centre line
  g.set(sternWall, cy, 'door', null);
  g.set(bowWall, cy, 'door', null);
}
