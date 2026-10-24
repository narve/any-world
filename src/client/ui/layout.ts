/**
 * Responsive layout decisions (DESIGN §6b). Pure functions, no DOM:
 *  - `layoutFor(w, h)` names the layout for a viewport size; the UI root carries it as
 *    `data-layout` and the stylesheet arranges the game screen from it.
 *  - `coverInsets(rects, w, h)` works out how much of the map the overlay covers along each edge,
 *    for Renderer.setViewportInsets (the player stays centred in the part that is still visible).
 */

export type LayoutMode = 'phone-portrait' | 'phone-landscape' | 'tablet' | 'desktop';

/** phones in portrait: narrower than this (CSS px) */
export const PHONE_MAX_WIDTH = 640;
/** phones in landscape: shorter than this and wider than tall */
export const PHONE_MAX_HEIGHT = 500;
/** tablets (and small laptop windows): narrower than this */
export const TABLET_MAX_WIDTH = 1100;

export function layoutFor(width: number, height: number): LayoutMode {
  if (width <= PHONE_MAX_WIDTH) return 'phone-portrait';
  if (height <= PHONE_MAX_HEIGHT && width > height) return 'phone-landscape';
  if (width <= TABLET_MAX_WIDTH) return 'tablet';
  return 'desktop';
}

/** phone layouts: bottom sheets, ticker log, compact HUD */
export function isCompact(mode: LayoutMode): boolean {
  return mode === 'phone-portrait' || mode === 'phone-landscape';
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The parts of a `width`×`height` viewport covered by overlay panels, as edge insets. A panel group
 * only counts as covering an edge when it forms a band along that edge, spanning more than
 * `bandShare` of the edge's length: a lone corner panel does not shrink the map, a full-width HUD
 * on a phone does, and so do the side columns of a phone in landscape. It is meant for the phone
 * layouts; on tablets and desktops the controller passes no panels (safe areas only).
 * Side columns are found first (panels in the outer third that stay off the middle); the top and
 * bottom bands are then measured among the remaining panels, against the width left between the
 * columns. The result leaves at least `minFree` of each axis uncovered. `safe` adds device
 * safe-area insets where no panel covers more.
 */
export function coverInsets(rects: readonly RectLike[], width: number, height: number, opts: { bandShare?: number; minFree?: number; safe?: Partial<Insets> } = {}): Insets {
  const share = opts.bandShare ?? 0.55;
  const minFree = opts.minFree ?? 0.3;
  const ins: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  if (width <= 0 || height <= 0) return ins;
  const vis = rects
    .filter((r) => r.right > r.left && r.bottom > r.top && r.right > 0 && r.bottom > 0 && r.left < width && r.top < height)
    .map((r) => ({ left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(width, r.right), bottom: Math.min(height, r.bottom) }));
  const leftCol = vis.filter((r) => r.left < width / 3 && r.right <= width / 2);
  const rightCol = vis.filter((r) => r.right > (width * 2) / 3 && r.left >= width / 2);
  if (leftCol.length && covered(leftCol, 'y') > height * share) ins.left = Math.max(...leftCol.map((r) => r.right));
  if (rightCol.length && covered(rightCol, 'y') > height * share) ins.right = width - Math.min(...rightCol.map((r) => r.left));
  const rest = vis.filter((r) => !(ins.left && leftCol.includes(r)) && !(ins.right && rightCol.includes(r)));
  const innerW = Math.max(1, width - ins.left - ins.right);
  const clipX = (rs: RectLike[]) => rs.map((r) => ({ ...r, left: Math.max(r.left, ins.left), right: Math.min(r.right, width - ins.right) })).filter((r) => r.right > r.left);
  const topBand = clipX(rest.filter((r) => r.top < height / 3 && r.bottom <= height / 2));
  const bottomBand = clipX(rest.filter((r) => r.bottom > (height * 2) / 3 && r.top >= height / 2));
  if (topBand.length && covered(topBand, 'x') > innerW * share) ins.top = Math.max(...topBand.map((r) => r.bottom));
  if (bottomBand.length && covered(bottomBand, 'x') > innerW * share) ins.bottom = height - Math.min(...bottomBand.map((r) => r.top));
  const safe = opts.safe ?? {};
  ins.top = Math.max(ins.top, safe.top ?? 0);
  ins.bottom = Math.max(ins.bottom, safe.bottom ?? 0);
  ins.left = Math.max(ins.left, safe.left ?? 0);
  ins.right = Math.max(ins.right, safe.right ?? 0);
  // never leave less than minFree of an axis for the map
  const fit = (a: 'top' | 'left', b: 'bottom' | 'right', size: number) => {
    const max = size * (1 - minFree);
    const sum = ins[a] + ins[b];
    if (sum > max) {
      const k = max / sum;
      ins[a] = ins[a] * k;
      ins[b] = ins[b] * k;
    }
  };
  fit('top', 'bottom', height);
  fit('left', 'right', width);
  return { top: Math.round(ins.top), bottom: Math.round(ins.bottom), left: Math.round(ins.left), right: Math.round(ins.right) };
}

/** total length of the union of the rectangles' projections on one axis */
function covered(rs: readonly RectLike[], axis: 'x' | 'y'): number {
  const iv = rs.map((r) => (axis === 'x' ? [r.left, r.right] : [r.top, r.bottom]) as [number, number]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of iv) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** two insets are the same within `eps` px (avoid re-framing the camera for 1 px jitter) */
export function sameInsets(a: Insets | null, b: Insets, eps = 2): boolean {
  if (!a) return false;
  return Math.abs(a.top - b.top) <= eps && Math.abs(a.bottom - b.bottom) <= eps && Math.abs(a.left - b.left) <= eps && Math.abs(a.right - b.right) <= eps;
}

/** rectangles that overlap by more than `tol` px in both axes */
export function overlaps(a: RectLike, b: RectLike, tol = 1): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > tol && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tol;
}

/** a rectangle fully inside the viewport (with `tol` px slack) */
export function inViewport(r: RectLike, width: number, height: number, tol = 1): boolean {
  return r.left >= -tol && r.top >= -tol && r.right <= width + tol && r.bottom <= height + tol;
}
