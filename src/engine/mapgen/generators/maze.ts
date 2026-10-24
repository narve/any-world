/**
 * Maze: recursive-backtracker perfect maze on odd coordinates, braided with extra openings
 * (loops), dead ends partially filled, plus a few open chambers.
 */
import { bySize, type GenContext } from '../context';
import { shuffle } from '../grid';

export function genMaze(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const cols = Math.floor((g.w - 1) / 2);
  const rows = Math.floor((g.h - 1) / 2);
  g.fillRect(1, 1, g.w - 2, g.h - 2, 'wall');
  const tx = (c: number) => 2 * c + 1;
  const visited = new Uint8Array(cols * rows);
  const stack: number[] = [rng.int(0, cols * rows - 1)];
  visited[stack[0]] = 1;
  g.set(tx(stack[0] % cols), tx(Math.floor(stack[0] / cols)), 'floor');
  const D = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  while (stack.length) {
    const c = stack[stack.length - 1];
    const cx = c % cols;
    const cy = (c - cx) / cols;
    const opts: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = cx + D[d][0];
      const ny = cy + D[d][1];
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !visited[ny * cols + nx]) opts.push(d);
    }
    if (!opts.length) {
      stack.pop();
      continue;
    }
    const d = opts[rng.int(0, opts.length - 1)];
    const nx = cx + D[d][0];
    const ny = cy + D[d][1];
    visited[ny * cols + nx] = 1;
    g.set(tx(cx) + D[d][0], tx(cy) + D[d][1], 'floor');
    g.set(tx(nx), tx(ny), 'floor');
    stack.push(ny * cols + nx);
  }

  // braid: knock out internal walls between two cells
  const loops = ctx.param(['loops', 'braid'], 0.12, 0, 0.6);
  const walls: [number, number][] = [];
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      if (g.kind(x, y) !== 'wall') continue;
      const ew = x % 2 === 0 && y % 2 === 1 && x + 1 <= tx(cols - 1);
      const ns = x % 2 === 1 && y % 2 === 0 && y + 1 <= tx(rows - 1);
      if (ew || ns) walls.push([x, y]);
    }
  shuffle(walls, rng);
  const knock = Math.round(walls.length * loops * 0.5);
  for (let k = 0; k < knock; k++) g.set(walls[k][0], walls[k][1], 'floor');

  // chambers
  const chambers = Math.round(ctx.param(['chambers', 'rooms'], bySize(size, 2, 3, 4), 0, 8));
  for (let k = 0; k < chambers; k++) {
    const cw = rng.int(1, 2);
    const ch = rng.int(1, 2);
    const c0 = rng.int(0, cols - 1 - cw);
    const r0 = rng.int(0, rows - 1 - ch);
    const id = g.newRegion();
    g.fillRect(tx(c0), tx(r0), tx(c0 + cw), tx(r0 + ch), 'floor', id);
  }

  // shorten some dead ends (fill the tip) for a less tedious maze
  const deadEnds = ctx.param('deadEnds', 0.6, 0, 1);
  const fillDeadEnds = Math.round((1 - deadEnds) * 2);
  for (let pass = 0; pass < fillDeadEnds; pass++) {
    const tips: [number, number][] = [];
    for (let y = 1; y < g.h - 1; y++)
      for (let x = 1; x < g.w - 1; x++) {
        if (g.kind(x, y) !== 'floor' || g.tile(x, y).region !== undefined) continue;
        let n = 0;
        if (g.passable(x + 1, y)) n++;
        if (g.passable(x - 1, y)) n++;
        if (g.passable(x, y + 1)) n++;
        if (g.passable(x, y - 1)) n++;
        if (n === 1) tips.push([x, y]);
      }
    for (const [x, y] of tips) if (rng.chance(0.5)) g.set(x, y, 'wall');
  }
  ctx.voronoi = 70;
  ctx.carveDoors = false;
}
