/**
 * Arena: a large octagonal central floor with a symmetric pillar lattice, ringed by side rooms
 * (alcoves, cells, galleries) whose doors open onto the arena.
 */
import { bySize, type GenContext, type Rect } from '../context';
import { canBlockLocally } from '../grid';

export function genArena(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const d = bySize(size, 3, 3, 4); // side-room interior depth
  const ax1 = d + 3;
  const ay1 = d + 3;
  const ax2 = g.w - 1 - (d + 3);
  const ay2 = g.h - 1 - (d + 3);
  g.fillRect(1, 1, g.w - 2, g.h - 2, 'wall');
  const arena = g.newRegion();
  const aw = ax2 - ax1 + 1;
  const ah = ay2 - ay1 + 1;
  const cut = Math.max(1, Math.floor(Math.min(aw, ah) / 4) - rng.int(0, 1));
  for (let y = ay1; y <= ay2; y++)
    for (let x = ax1; x <= ax2; x++) {
      const dx = Math.min(x - ax1, ax2 - x);
      const dy = Math.min(y - ay1, ay2 - y);
      if (dx + dy >= cut) g.set(x, y, 'floor', arena);
    }

  // pillars: symmetric lattice, each pillar keeps a 2-tile clearance from any wall
  const pillarCountParam = ctx.param(['pillars', 'pillarCount'], -1, 0, 200);
  let density = ctx.param('pillarDensity', 0.55, 0, 1);
  const spacing = size === 'large' && rng.chance(0.5) ? 4 : 3;
  const cx = (ax1 + ax2) / 2;
  const cy = (ay1 + ay2) / 2;
  const lattice: { x: number; y: number }[] = [];
  for (let y = ay1 + 2; y <= cy; y += spacing)
    for (let x = ax1 + 2; x <= cx; x += spacing) lattice.push({ x, y });
  if (pillarCountParam >= 0 && lattice.length) density = Math.min(1, pillarCountParam / (lattice.length * 4));
  const clear = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const k = g.kind(x + dx, y + dy);
        if (k !== 'floor') return false;
      }
    return true;
  };
  const passable = (x: number, y: number) => g.passable(x, y);
  const ringPillars = size !== 'small' && rng.chance(0.4);
  for (const p of lattice) {
    if (!rng.chance(density)) continue;
    const mirrors = [
      [p.x, p.y],
      [ax1 + ax2 - p.x, p.y],
      [p.x, ay1 + ay2 - p.y],
      [ax1 + ax2 - p.x, ay1 + ay2 - p.y],
    ];
    for (const [x, y] of mirrors) if (clear(x, y) && canBlockLocally(passable, x, y)) g.set(x, y, 'wall', null);
  }
  if (ringPillars) {
    // ring of pillars around the centre (a dais)
    const r = Math.min(aw, ah) / 5;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const x = Math.round(cx + Math.cos(a) * r * 1.4);
      const y = Math.round(cy + Math.sin(a) * r);
      if (clear(x, y) && canBlockLocally(passable, x, y)) g.set(x, y, 'wall', null);
    }
  }

  // side rooms in the four bands
  const keep = ctx.param('sideRooms', 0.8, 0, 1);
  const horizontalBand = (wallY: number, outerY: number, intoArenaY: number) => {
    // rooms span x in [ax1-1, ax2+1] (wall lines), interior rows between outerY and wallY
    const yA = Math.min(wallY, outerY);
    const yB = Math.max(wallY, outerY);
    let cur = ax1 - 1;
    while (cur < ax2 + 1) {
      let next = cur + rng.int(4, 8) + 1;
      if (ax2 + 1 - next < 4) next = ax2 + 1;
      if (next - cur < 3) break;
      const room: Rect = { x1: cur + 1, y1: yA + 1, x2: next - 1, y2: yB - 1 };
      if (rng.chance(keep)) {
        const doors: number[] = [];
        for (let x = room.x1; x <= room.x2; x++) if (g.kind(x, intoArenaY) === 'floor') doors.push(x);
        if (doors.length) {
          const id = g.newRegion();
          g.fillRect(room.x1, room.y1, room.x2, room.y2, 'floor', id);
          g.set(doors[rng.int(0, doors.length - 1)], wallY, 'door', null);
        }
      }
      cur = next;
    }
  };
  const verticalBand = (wallX: number, outerX: number, intoArenaX: number) => {
    const xA = Math.min(wallX, outerX);
    const xB = Math.max(wallX, outerX);
    let cur = ay1 - 1;
    while (cur < ay2 + 1) {
      let next = cur + rng.int(3, 6) + 1;
      if (ay2 + 1 - next < 3) next = ay2 + 1;
      if (next - cur < 3) break;
      const room: Rect = { x1: xA + 1, y1: cur + 1, x2: xB - 1, y2: next - 1 };
      if (rng.chance(keep)) {
        const doors: number[] = [];
        for (let y = room.y1; y <= room.y2; y++) if (g.kind(intoArenaX, y) === 'floor') doors.push(y);
        if (doors.length) {
          const id = g.newRegion();
          g.fillRect(room.x1, room.y1, room.x2, room.y2, 'floor', id);
          g.set(wallX, doors[rng.int(0, doors.length - 1)], 'door', null);
        }
      }
      cur = next;
    }
  };
  horizontalBand(ay1 - 1, ay1 - d - 2, ay1);
  horizontalBand(ay2 + 1, ay2 + d + 2, ay2);
  verticalBand(ax1 - 1, ax1 - d - 2, ax1);
  verticalBand(ax2 + 1, ax2 + d + 2, ax2);
}
