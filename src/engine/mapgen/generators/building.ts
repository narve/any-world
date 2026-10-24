/**
 * Multi-room interior: one long hallway with optional cross hallways; the blocks between
 * hallways are cut into rooms of varied width (large halls and small offices), deep blocks get
 * a second row of rooms reached through the front rooms. Optional corner cut for an L-shape.
 */
import { bySize, type GenContext, type Rect } from '../context';

/** wall-coordinate rect: x1/x2/y1/y2 are wall lines, interior is strictly inside */
type WallRect = Rect;

interface Block {
  r: WallRect;
  /** which wall line faces the main hallway */
  front: 'top' | 'bottom';
}

export function genBuilding(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const ox1 = rng.int(1, 2);
  const oy1 = rng.int(1, 2);
  const ox2 = g.w - 1 - rng.int(1, 2);
  const oy2 = g.h - 1 - rng.int(1, 2);
  g.fillRect(ox1, oy1, ox2, oy2, 'wall');

  const hw = Math.round(ctx.param(['corridorWidth', 'hallWidth'], bySize(size, 2, rng.int(2, 3), 3), 1, 4));
  // main hallway rows [hy, hy+hw-1]; walls at hy-1 and hy+hw
  const minDepth = 4; // interior rows of a block >= 3
  const hyLo = oy1 + minDepth + 1;
  const hyHi = oy2 - minDepth - hw;
  const hy = rng.int(hyLo, Math.max(hyLo, hyHi));
  const hall = g.newRegion();
  g.fillRect(ox1 + 1, hy, ox2 - 1, hy + hw - 1, 'floor', hall);

  // cross hallways (vertical)
  const vCount = Math.round(ctx.param(['crossHalls', 'halls', 'hall'], bySize(size, 1, rng.int(1, 2), 2), 0, 3));
  const vw = Math.max(1, Math.min(hw, 2));
  const vxs: number[] = [];
  for (let k = 0; k < vCount; k++) {
    for (let t = 0; t < 30; t++) {
      const vx = rng.int(ox1 + 6, ox2 - 5 - vw);
      if (vxs.every((o) => Math.abs(o - vx) >= 9)) {
        vxs.push(vx);
        break;
      }
    }
  }
  vxs.sort((a, b) => a - b);
  for (const vx of vxs) {
    const mode = rng.int(0, 2); // 0 full, 1 upper only, 2 lower only
    const yA = mode === 2 ? hy : oy1 + 1;
    const yB = mode === 1 ? hy + hw - 1 : oy2 - 1;
    g.fillRect(vx, yA, vx + vw - 1, yB, 'floor', hall);
  }

  // x segments between vertical hallways (wall lines bounding each segment)
  const xCuts: [number, number][] = [];
  let left = ox1;
  for (const vx of vxs) {
    xCuts.push([left, vx - 1]);
    left = vx + vw;
  }
  xCuts.push([left, ox2]);

  const blocks: Block[] = [];
  for (const [xa, xb] of xCuts) {
    blocks.push({ r: { x1: xa, y1: oy1, x2: xb, y2: hy - 1 }, front: 'bottom' });
    blocks.push({ r: { x1: xa, y1: hy + hw, x2: xb, y2: oy2 }, front: 'top' });
  }

  for (const b of blocks) {
    const { r } = b;
    if (r.x2 - r.x1 < 4) continue; // too narrow for rooms; leave solid
    const depth = r.y2 - r.y1 - 1;
    const split = depth >= 9 && rng.chance(0.65);
    let frontRect: WallRect = r;
    let backRect: WallRect | null = null;
    if (split) {
      const frontDepth = rng.int(3, depth - 4);
      if (b.front === 'bottom') {
        const sy = r.y2 - frontDepth - 1;
        frontRect = { ...r, y1: sy };
        backRect = { ...r, y2: sy };
      } else {
        const sy = r.y1 + frontDepth + 1;
        frontRect = { ...r, y2: sy };
        backRect = { ...r, y1: sy };
      }
    }
    const fronts = cutRooms(ctx, frontRect);
    const frontWallY = b.front === 'bottom' ? frontRect.y2 : frontRect.y1;
    for (const room of fronts) {
      const dx = rng.int(room.x1 + 1, room.x2 - 1);
      g.set(dx, frontWallY, rng.chance(0.85) ? 'door' : 'floor', null);
      // a second door for big rooms
      if (room.x2 - room.x1 >= 9 && rng.chance(0.5)) {
        const dx2 = rng.int(room.x1 + 1, room.x2 - 1);
        if (Math.abs(dx2 - dx) >= 3) g.set(dx2, frontWallY, 'door', null);
      }
    }
    sideDoors(ctx, fronts, frontRect);
    if (backRect) {
      const backs = cutRooms(ctx, backRect);
      const shareY = b.front === 'bottom' ? backRect.y2 : backRect.y1;
      for (const room of backs) {
        // door into an overlapping front room
        const opts: number[] = [];
        for (let x = room.x1 + 1; x <= room.x2 - 1; x++) {
          const inner = b.front === 'bottom' ? shareY + 1 : shareY - 1;
          if (g.kind(x, inner) === 'floor') opts.push(x);
        }
        if (opts.length) g.set(opts[rng.int(0, opts.length - 1)], shareY, 'door', null);
      }
      sideDoors(ctx, backs, backRect);
    }
  }

  // doors from rooms onto adjacent cross hallways
  for (const vx of vxs) {
    for (const wx of [vx - 1, vx + vw]) {
      for (let y = oy1 + 1; y < oy2; y++) {
        const inside = wx === vx - 1 ? wx - 1 : wx + 1;
        if (g.kind(wx, y) === 'wall' && g.kind(inside, y) === 'floor' && g.kind(vx, y) === 'floor' && g.kind(wx, y - 1) === 'wall' && g.kind(wx, y + 1) === 'wall' && rng.chance(0.06)) {
          g.set(wx, y, 'door', null);
        }
      }
    }
  }

  // optional corner cut → L-shaped footprint
  if (size !== 'small' && rng.chance(0.35)) {
    const cw = Math.floor((ox2 - ox1) * (0.2 + rng.next() * 0.15));
    const ch = Math.floor((oy2 - oy1) * (0.25 + rng.next() * 0.1));
    const right = rng.chance(0.5);
    const top = rng.chance(0.5);
    const x1 = right ? ox2 - cw : ox1;
    const x2 = right ? ox2 : ox1 + cw;
    const y1 = top ? oy1 : oy2 - ch;
    const y2 = top ? oy1 + ch : oy2;
    // keep the main hallway intact
    if (y2 < hy - 1 || y1 > hy + hw) g.fillRect(x1, y1, x2, y2, 'void', null);
  }
}

/** split a wall-rect strip along x into rooms (wall lines shared); returns room wall-rects */
function cutRooms(ctx: GenContext, r: WallRect): WallRect[] {
  const { g, rng } = ctx;
  const rooms: WallRect[] = [];
  let cur = r.x1;
  while (cur < r.x2) {
    const big = rng.chance(0.35);
    const inner = big ? rng.int(7, 11) : rng.int(3, 6);
    let next = cur + inner + 1;
    if (r.x2 - next < 4) next = r.x2;
    if (next - cur < 4) {
      // too thin leftover; merge into previous room by removing its right wall
      if (rooms.length) {
        const prev = rooms[rooms.length - 1];
        const id = g.tile(prev.x2 - 1, r.y1 + 1).region ?? null;
        g.fillRect(prev.x2, r.y1 + 1, next - 1, r.y2 - 1, 'floor', id);
        prev.x2 = next;
      }
      break;
    }
    const room: WallRect = { x1: cur, y1: r.y1, x2: next, y2: r.y2 };
    const id = g.newRegion();
    g.fillRect(cur + 1, r.y1 + 1, next - 1, r.y2 - 1, 'floor', id);
    rooms.push(room);
    cur = next;
  }
  return rooms;
}

/** occasional doors between side-by-side rooms */
function sideDoors(ctx: GenContext, rooms: WallRect[], r: WallRect): void {
  const { g, rng } = ctx;
  for (let k = 0; k + 1 < rooms.length; k++) {
    if (!rng.chance(0.3)) continue;
    const x = rooms[k].x2;
    const y = rng.int(r.y1 + 1, r.y2 - 1);
    if (g.kind(x - 1, y) === 'floor' && g.kind(x + 1, y) === 'floor') g.set(x, y, 'door', null);
  }
}
