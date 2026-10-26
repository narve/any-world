/** Rooms & corridors: separated rectangular rooms joined by an MST of winding corridors with doors. */
import type { Pos } from '../../types';
import { bySize, type GenContext, type Rect } from '../context';
import { dijkstraPath } from '../grid';

function centre(r: Rect): { x: number; y: number } {
  return { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
}

/** door on the room side facing (tx,ty); returns door tile and the tile just outside it */
function doorToward(ctx: GenContext, r: Rect, tx: number, ty: number): { door: Pos; out: Pos } {
  const { rng } = ctx;
  const c = centre(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  const rw = r.x2 - r.x1 + 1;
  const rh = r.y2 - r.y1 + 1;
  if (Math.abs(dx) / rw > Math.abs(dy) / rh) {
    const y = rng.int(r.y1, r.y2);
    return dx > 0 ? { door: { x: r.x2 + 1, y }, out: { x: r.x2 + 2, y } } : { door: { x: r.x1 - 1, y }, out: { x: r.x1 - 2, y } };
  }
  const x = rng.int(r.x1, r.x2);
  return dy > 0 ? { door: { x, y: r.y2 + 1 }, out: { x, y: r.y2 + 2 } } : { door: { x, y: r.y1 - 1 }, out: { x, y: r.y1 - 2 } };
}

export function genRooms(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const target = Math.round(ctx.param(['roomCount', 'rooms'], bySize(size, 7, 10, 14), 2, 30));
  const minSide = Math.round(ctx.param('roomMin', bySize(size, 4, 3, 3), 2, 8));
  const maxSide = Math.max(minSide, Math.round(ctx.param('roomMax', bySize(size, 7, 10, 12), 3, 16)));
  const rooms: Rect[] = [];
  const fits = (r: Rect) =>
    rooms.every((o) => r.x1 >= o.x2 + 4 || o.x1 >= r.x2 + 4 || r.y1 >= o.y2 + 4 || o.y1 >= r.y2 + 4);
  // the first two rooms go into opposite corners so the level spans the map
  const flipX = rng.chance(0.5);
  const flipY = rng.chance(0.5);
  let tries = 0;
  while (rooms.length < target && tries < target * 80) {
    tries++;
    const w = rng.int(minSide, maxSide);
    const h = rng.int(minSide, Math.max(minSide, Math.round(maxSide * 0.75)));
    if (w + 6 > g.w || h + 6 > g.h) continue;
    let x1 = rng.int(3, g.w - 4 - w);
    let y1 = rng.int(3, g.h - 4 - h);
    if (rooms.length < 2 && tries < 40) {
      const corner = rooms.length === 0 ? flipX : !flipX;
      const cornerY = rooms.length === 0 ? flipY : !flipY;
      x1 = corner ? g.w - 4 - w - rng.int(0, 2) : 3 + rng.int(0, 2);
      y1 = cornerY ? g.h - 4 - h - rng.int(0, 2) : 3 + rng.int(0, 2);
    }
    const r = { x1, y1, x2: x1 + w - 1, y2: y1 + h - 1 };
    if (fits(r)) rooms.push(r);
  }
  // guarantee at least two far-apart rooms
  if (rooms.length < 2) {
    rooms.length = 0;
    rooms.push({ x1: 3, y1: 3, x2: 6, y2: 6 }, { x1: g.w - 7, y1: g.h - 7, x2: g.w - 4, y2: g.h - 4 });
  }
  const blocked = new Uint8Array(g.w * g.h);
  rooms.forEach((r) => {
    const id = g.newRegion();
    g.fillRect(r.x1, r.y1, r.x2, r.y2, 'floor', id);
    for (let y = r.y1 - 1; y <= r.y2 + 1; y++) for (let x = r.x1 - 1; x <= r.x2 + 1; x++) blocked[g.idx(x, y)] = 1;
    // pillars in big rooms
    const rw = r.x2 - r.x1 + 1;
    const rh = r.y2 - r.y1 + 1;
    if (rw >= 7 && rh >= 7 && rng.chance(0.4)) {
      for (let y = r.y1 + 2; y <= r.y2 - 2; y += 3) for (let x = r.x1 + 2; x <= r.x2 - 2; x += 3) g.set(x, y, 'wall', null);
    }
  });

  // edges: Prim MST over room centres + a few loops
  const n = rooms.length;
  const d2 = (a: number, b: number) => {
    const ca = centre(rooms[a]);
    const cb = centre(rooms[b]);
    return (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2;
  };
  const edges: [number, number][] = [];
  const inTree = [true, ...new Array(n - 1).fill(false)];
  for (let k = 1; k < n; k++) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let a = 0; a < n; a++) {
      if (!inTree[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inTree[b]) continue;
        const d = d2(a, b);
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
    }
    if (!best) break;
    inTree[best[1]] = true;
    edges.push(best);
  }
  const loops = Math.round(ctx.param('loops', 0.25, 0, 1) * n);
  for (let k = 0; k < loops; k++) {
    const a = rng.int(0, n - 1);
    // nearest room not already linked
    let best = -1;
    let bestD = Infinity;
    for (let b = 0; b < n; b++) {
      if (b === a || edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) continue;
      const d = d2(a, b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best >= 0) edges.push([a, best]);
  }
  // a room with a single corridor is a dead end: most get a second one to their nearest other room
  // (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §3.4)
  const throughShare = ctx.param('throughRooms', 0.8, 0, 1);
  for (let a = 0; a < n && n > 2; a++) {
    if (edges.filter(([p, q]) => p === a || q === a).length !== 1 || !rng.chance(throughShare)) continue;
    let best = -1;
    let bestD = Infinity;
    for (let b = 0; b < n; b++) {
      if (b === a || edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) continue;
      const d = d2(a, b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best >= 0) edges.push([a, best]);
  }

  const noise = new Uint8Array(g.w * g.h);
  for (let i = 0; i < noise.length; i++) noise[i] = rng.int(0, 2);
  const corridor = new Uint8Array(g.w * g.h);
  // doors already cut per room; a new door next to an existing one reuses it
  const doors: { door: Pos; out: Pos }[][] = rooms.map(() => []);
  const reuseDoor = (d: { door: Pos; out: Pos }, list: { door: Pos; out: Pos }[]) => {
    const near = list.find((o) => Math.abs(o.door.x - d.door.x) <= 2 && Math.abs(o.door.y - d.door.y) <= 2);
    if (near) return near;
    list.push(d);
    return d;
  };
  for (const [a, b] of edges) {
    const ca = centre(rooms[a]);
    const cb = centre(rooms[b]);
    const da = reuseDoor(doorToward(ctx, rooms[a], cb.x, cb.y), doors[a]);
    const db = reuseDoor(doorToward(ctx, rooms[b], ca.x, ca.y), doors[b]);
    const target = g.idx(db.out.x, db.out.y);
    const path = dijkstraPath(
      g.w,
      g.h,
      [g.idx(da.out.x, da.out.y)],
      (i) => i === target,
      (i) => {
        const x = i % g.w;
        const y = (i - x) / g.w;
        if (x < 1 || y < 1 || x > g.w - 2 || y > g.h - 2) return Infinity;
        if (blocked[i]) return Infinity;
        return (corridor[i] ? 1 : 3) + noise[i];
      },
    );
    if (!path) continue;
    for (const i of path) {
      corridor[i] = 1;
      g.tiles[i].kind = 'floor';
    }
    for (const d of [da.door, db.door]) {
      if (g.kind(d.x, d.y) === 'void') g.set(d.x, d.y, rng.chance(0.8) ? 'door' : 'floor', null);
    }
  }
}
