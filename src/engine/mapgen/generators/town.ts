/**
 * Town: open ground with an irregular edge, a main street and cross streets; buildings packed
 * into the blocks between streets, each with a door facing the main street and a walled
 * interior (larger ones split into two rooms). Spare lots get a little clutter.
 */
import { bySize, type GenContext, type Rect } from '../context';
import { canBlockLocally, shuffle } from '../grid';

export function genTown(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  // ground with an irregular edge (random walk depth 0..2 per column/row)
  const edge = (len: number) => {
    const out: number[] = [];
    let d = rng.int(0, 2);
    for (let i = 0; i < len; i++) {
      if (rng.chance(0.3)) d = Math.max(0, Math.min(2, d + (rng.chance(0.5) ? 1 : -1)));
      out.push(d);
    }
    return out;
  };
  const top = edge(g.w);
  const bottom = edge(g.w);
  const leftE = edge(g.h);
  const rightE = edge(g.h);
  const ground = g.newRegion();
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      if (y - 1 < top[x] || g.h - 2 - y < bottom[x] || x - 1 < leftE[y] || g.w - 2 - x < rightE[y]) continue;
      g.set(x, y, 'floor', ground);
    }

  const inX1 = 4;
  const inX2 = g.w - 5;
  const inY1 = 4;
  const inY2 = g.h - 5;
  const sw = Math.round(ctx.param(['streetWidth', 'mainStreet'], 3, 2, 5));
  const my = rng.int(Math.floor(g.h / 2) - 2, Math.floor(g.h / 2)) - Math.floor(sw / 2) + 1;
  const crossCount = Math.round(ctx.param(['crossStreets', 'streets'], bySize(size, 1, rng.int(1, 2), 2), 0, 3));
  const cw = Math.max(2, sw - 1);
  const crosses: number[] = [];
  for (let k = 0; k < crossCount; k++) {
    for (let t = 0; t < 30; t++) {
      const cx = rng.int(inX1 + 6, inX2 - 6 - cw);
      if (crosses.every((o) => Math.abs(o - cx) >= 12)) {
        crosses.push(cx);
        break;
      }
    }
  }
  crosses.sort((a, b) => a - b);

  // blocks between streets (inclusive ground rects that may hold buildings); 1-tile sidewalk
  const xSegs: [number, number][] = [];
  let lx = inX1;
  for (const cx of crosses) {
    xSegs.push([lx, cx - 2]);
    lx = cx + cw + 1;
  }
  xSegs.push([lx, inX2]);
  const ySegs: { y1: number; y2: number; front: 'top' | 'bottom' }[] = [
    { y1: inY1, y2: my - 2, front: 'bottom' },
    { y1: my + sw + 1, y2: inY2, front: 'top' },
  ];

  interface Building { r: Rect; front: 'top' | 'bottom' }
  const buildings: Building[] = [];
  for (const [bx1, bx2] of xSegs) {
    for (const seg of ySegs) {
      if (bx2 - bx1 < 4 || seg.y2 - seg.y1 < 3) continue;
      // rows of buildings starting from the street side
      let rowEdge = seg.front === 'bottom' ? seg.y2 : seg.y1;
      for (;;) {
        const room = seg.front === 'bottom' ? rowEdge - seg.y1 + 1 : seg.y2 - rowEdge + 1;
        if (room < 4) break;
        const rowDepth = rng.int(4, Math.min(8, room));
        let cx = bx1 + rng.int(0, 1);
        while (bx2 - cx + 1 >= 5) {
          const wdt = Math.min(rng.int(5, 9), bx2 - cx + 1);
          const dep = rng.int(Math.max(4, rowDepth - 2), rowDepth);
          const r =
            seg.front === 'bottom'
              ? { x1: cx, x2: cx + wdt - 1, y1: rowEdge - dep + 1, y2: rowEdge }
              : { x1: cx, x2: cx + wdt - 1, y1: rowEdge, y2: rowEdge + dep - 1 };
          buildings.push({ r, front: seg.front });
          cx += wdt + rng.int(1, 3);
        }
        rowEdge = seg.front === 'bottom' ? rowEdge - rowDepth - rng.int(1, 2) : rowEdge + rowDepth + rng.int(1, 2);
      }
    }
  }

  const want = Math.round(ctx.param(['buildings', 'buildingCount'], bySize(size, 6, 9, 14), 1, 40));
  // prefer buildings that front the main street, then random
  const frontage = (b: Building) => (b.front === 'bottom' ? b.r.y2 === my - 2 : b.r.y1 === my + sw + 1);
  shuffle(buildings, rng);
  buildings.sort((a, b) => Number(frontage(b)) - Number(frontage(a)));
  const kept = buildings.slice(0, want);
  const lots = buildings.slice(want);

  for (const b of kept) {
    const { r } = b;
    // only build on solid ground
    let ok = true;
    for (let y = r.y1 - 1; y <= r.y2 + 1 && ok; y++)
      for (let x = r.x1 - 1; x <= r.x2 + 1; x++) if (g.kind(x, y) !== 'floor' || g.tile(x, y).region !== ground) { ok = false; break; }
    if (!ok) continue;
    const id = g.newRegion();
    g.fillRect(r.x1, r.y1, r.x2, r.y2, 'wall', null);
    g.fillRect(r.x1 + 1, r.y1 + 1, r.x2 - 1, r.y2 - 1, 'floor', id);
    const fy = b.front === 'bottom' ? r.y2 : r.y1;
    const iw = r.x2 - r.x1 - 1;
    const ih = r.y2 - r.y1 - 1;
    if (iw >= 6 && ih >= 2 && rng.chance(0.5)) {
      // inner partition with a door; front door goes into one half
      const px = rng.int(r.x1 + 3, r.x2 - 3);
      for (let y = r.y1 + 1; y < r.y2; y++) g.set(px, y, 'wall', null);
      g.set(px, rng.int(r.y1 + 1, r.y2 - 1), 'door', null);
      const leftSide = rng.chance(0.5);
      const dx = leftSide ? rng.int(r.x1 + 1, px - 1) : rng.int(px + 1, r.x2 - 1);
      g.set(dx, fy, 'door', null);
    } else {
      g.set(rng.int(r.x1 + 1, r.x2 - 1), fy, 'door', null);
    }
    // occasional back door
    if (rng.chance(0.25)) {
      const by = b.front === 'bottom' ? r.y1 : r.y2;
      const bx = rng.int(r.x1 + 1, r.x2 - 1);
      const outY = b.front === 'bottom' ? by - 1 : by + 1;
      const inY = b.front === 'bottom' ? by + 1 : by - 1;
      if (g.kind(bx, outY) === 'floor' && g.kind(bx, inY) === 'floor') g.set(bx, by, 'door', null);
    }
  }

  // clutter on empty lots (fences, crates, trees — just obstacles)
  const passable = (x: number, y: number) => g.passable(x, y);
  for (const lot of lots) {
    if (!rng.chance(0.6)) continue;
    const n = rng.int(1, 4);
    for (let k = 0; k < n; k++) {
      const x = rng.int(lot.r.x1 + 1, lot.r.x2 - 1);
      const y = rng.int(lot.r.y1 + 1, lot.r.y2 - 1);
      if (g.kind(x, y) === 'floor' && g.tile(x, y).region === ground && canBlockLocally(passable, x, y)) g.set(x, y, 'wall', null);
    }
  }
}
