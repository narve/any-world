/**
 * MapOverlay — a 2D SVG layer over the 3D canvas that shows what a click will do before you click
 * (DESIGN §2.4 "you should always be able to tell what will happen"):
 *
 *  - hover outline of the tile under the mouse, coloured by what a click does (walk, attack, talk,
 *    use) and a dimmed X where there is no known way;
 *  - the click-to-travel route as faint dots;
 *  - a marker on the area exit once it has been seen, and an arrow at the screen edge pointing to it
 *    while it is off screen;
 *  - before the exit has been seen, a small faint compass chevron beside the player pointing in its
 *    general direction (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §1.2: walking is the slow part);
 *  - a pulsing ring around the NPC you are talking to;
 *  - while aiming a direction-targeted item (ray, cone), the eight directions around the player.
 *
 * The exit arrow and its label keep clear of the HUD panels over the map (rules, player card, log,
 * hotbar): see `placeEdgeMarker` (issues/M2-exit-label-under-panels.md).
 *
 * Positions are re-projected every animation frame through `project` (renderer.tileToScreen), so
 * the marks follow the camera's smooth follow, zoom and rotation. Pure DOM; no three.js.
 */
import type { Pos } from '../engine/types';
import type { HoverPreview } from './session';

const NS = 'http://www.w3.org/2000/svg';
/** at most this many route dots are drawn (long routes fade out after that) */
const MAX_DOTS = 40;
/** keep the exit arrow clear of the screen edge and the HUD (top bar, hotbar at the bottom) */
export const EDGE = { top: 96, right: 40, bottom: 120, left: 40 };
type Margins = typeof EDGE;

type Projector = (p: { x: number; y: number }) => { x: number; y: number };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** pure: where the exit arrow goes for an off-screen point (null when the point is on screen) */
export function edgeArrow(
  from: { x: number; y: number },
  to: { x: number; y: number },
  box: { w: number; h: number },
  margin: number | Margins = EDGE,
): { x: number; y: number; angle: number } | null {
  const m = typeof margin === 'number' ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
  const inside = to.x >= m.left && to.y >= m.top && to.x <= box.w - m.right && to.y <= box.h - m.bottom;
  if (inside) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  // walk from `from` toward `to` until the margin box is hit
  const tx = dx > 0 ? (box.w - m.right - from.x) / dx : dx < 0 ? (m.left - from.x) / dx : Infinity;
  const ty = dy > 0 ? (box.h - m.bottom - from.y) / dy : dy < 0 ? (m.top - from.y) / dy : Infinity;
  const t = Math.max(0, Math.min(tx, ty, 1));
  return { x: from.x + dx * t, y: from.y + dy * t, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function hits(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** wrap a label into at most `maxLines` lines of about `width` characters, with an ellipsis if cut */
export function wrapLabel(label: string, width = 24, maxLines = 2): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (w.length > width) w = `${w.slice(0, width - 1)}…`;
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines) {
      cur = '';
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.length >= width ? `${last.slice(0, width - 1).trimEnd()}…` : `${last}…`;
      return lines;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** where the label goes relative to the arrow tip, and its box (`anchor` is the SVG text-anchor) */
export function labelBox(
  at: { x: number; y: number },
  angle: number,
  size: { w: number; h: number },
): { x: number; y: number; anchor: 'start' | 'middle' | 'end'; rect: Rect } {
  const cos = Math.cos((angle * Math.PI) / 180);
  const sin = Math.sin((angle * Math.PI) / 180);
  const anchor = cos > 0.5 ? 'end' : cos < -0.5 ? 'start' : 'middle';
  const x = at.x - cos * 22;
  // the text block sits above the tip when the arrow points down, below when it points up
  const top = sin > 0.5 ? at.y - 22 - size.h : sin < -0.5 ? at.y + 22 : at.y - size.h / 2;
  const left = anchor === 'end' ? x - size.w : anchor === 'middle' ? x - size.w / 2 : x;
  return { x, y: top, anchor, rect: { x: left, y: top, w: size.w, h: size.h } };
}

/**
 * Pure: slide an edge arrow along the margin box until neither it nor its label overlaps a HUD
 * panel, keeping it pointed at the target. Returns the original placement when nothing fits.
 */
export function placeEdgeMarker(
  arrow: { x: number; y: number; angle: number },
  to: { x: number; y: number },
  label: { w: number; h: number },
  obstacles: Rect[],
  box: { w: number; h: number },
  margin: Margins = EDGE,
): { x: number; y: number; angle: number; label: ReturnType<typeof labelBox> } {
  const at = (x: number, y: number) => {
    const angle = x === to.x && y === to.y ? arrow.angle : (Math.atan2(to.y - y, to.x - x) * 180) / Math.PI;
    return { x, y, angle, label: labelBox({ x, y }, angle, label) };
  };
  const inBox = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= box.w && r.y + r.h <= box.h;
  const clear = (c: ReturnType<typeof at>) => {
    const tip: Rect = { x: c.x - 16, y: c.y - 16, w: 32, h: 32 };
    return inBox(c.label.rect) && !obstacles.some((o) => hits(o, tip) || hits(o, c.label.rect));
  };
  const first = at(arrow.x, arrow.y);
  if (clear(first)) return first;
  const onHorizontal = Math.abs(arrow.y - margin.top) < 1 || Math.abs(arrow.y - (box.h - margin.bottom)) < 1;
  const lo = onHorizontal ? margin.left : margin.top;
  const hi = onHorizontal ? box.w - margin.right : box.h - margin.bottom;
  const base = onHorizontal ? arrow.x : arrow.y;
  for (let d = 8; d <= hi - lo; d += 8) {
    for (const v of [base + d, base - d]) {
      if (v < lo || v > hi) continue;
      const c = onHorizontal ? at(v, arrow.y) : at(arrow.x, v);
      if (clear(c)) return c;
    }
  }
  return first;
}

/** how far from the player (in tiles) the compass chevron sits */
const COMPASS_RADIUS = 1.15;

/** the eight neighbours of the player, for direction-aimed items */
const DIRS8: [number, number][] = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

export class MapOverlay {
  readonly svg: SVGSVGElement;
  private hover: SVGPolygonElement;
  private cross: SVGPathElement;
  private dots: SVGGElement;
  private exitMark: SVGPolygonElement;
  private exitArrow: SVGGElement;
  private exitLabel: SVGTextElement;
  private ring: SVGEllipseElement;
  private compassEl: SVGGElement;
  private compass: Pos | null = null;
  private preview: HoverPreview | null = null;
  private exit: { pos: Pos; label: string } | null = null;
  private speaker: Pos | null = null;
  private player: Pos | null = null;
  private dotEls: SVGCircleElement[] = [];
  private dirs: SVGGElement;
  private dirEls: SVGPathElement[] = [];
  private aim: { from: Pos; at: Pos } | null = null;
  private labelLines: string[] = [];
  /** HUD panels to keep the exit marker clear of (viewport rectangles) */
  private avoid: () => DOMRect[] = () => [];

  constructor(
    host: HTMLElement,
    private project: Projector,
  ) {
    this.svg = el('svg', { class: 'aw-map-overlay', 'aria-hidden': 'true' });
    this.dots = el('g', { class: 'ov-dots' });
    this.hover = el('polygon', { class: 'ov-hover' });
    this.cross = el('path', { class: 'ov-cross' });
    this.exitMark = el('polygon', { class: 'ov-exit' });
    this.exitArrow = el('g', { class: 'ov-exit-arrow' });
    this.exitArrow.append(el('path', { d: 'M -14 -10 L 6 0 L -14 10 L -9 0 Z' }));
    this.exitLabel = el('text', { class: 'ov-exit-label', 'text-anchor': 'middle' });
    this.ring = el('ellipse', { class: 'ov-speaker' });
    this.compassEl = el('g', { class: 'ov-compass' });
    this.compassEl.append(el('path', { d: 'M -5 -6 L 3 0 L -5 6' }));
    this.dirs = el('g', { class: 'ov-dirs' });
    for (let i = 0; i < DIRS8.length; i++) {
      const p = el('path', { d: 'M -7 -6 L 5 0 L -7 6 Z' });
      this.dirs.appendChild(p);
      this.dirEls.push(p);
    }
    this.svg.append(this.exitMark, this.compassEl, this.ring, this.dots, this.dirs, this.hover, this.cross, this.exitArrow, this.exitLabel);
    host.appendChild(this.svg);
    this.hideAll();
  }

  setPreview(p: HoverPreview | null): void {
    this.preview = p;
    const n = p ? Math.min(MAX_DOTS, Math.max(0, p.path.length - 1)) : 0;
    while (this.dotEls.length < n) {
      const c = el('circle', { r: '3.2' });
      this.dots.appendChild(c);
      this.dotEls.push(c);
    }
    this.dotEls.forEach((c, i) => c.toggleAttribute('hidden', i >= n));
    this.svg.dataset.kind = p?.kind ?? '';
  }

  setExit(exit: { pos: Pos; label: string } | null): void {
    this.exit = exit;
    const lines = wrapLabel(exit?.label ?? '');
    if (lines.join('\n') === this.labelLines.join('\n')) return;
    this.labelLines = lines;
    this.exitLabel.textContent = '';
    for (const line of lines) {
      const t = el('tspan', { dy: '1.15em' });
      t.textContent = line;
      this.exitLabel.appendChild(t);
    }
  }

  /** rectangles of the HUD panels over the map, which the exit marker keeps clear of */
  setAvoid(fn: () => DOMRect[]): void {
    this.avoid = fn;
  }

  /**
   * Direction aiming: draw the eight direction choices around `from`, the one toward `at` lit.
   * null hides them.
   */
  setAim(aim: { from: Pos; at: Pos } | null): void {
    this.aim = aim;
  }

  /** the not-yet-seen goal the compass chevron points toward (null hides it) */
  setCompass(target: Pos | null): void {
    this.compass = target;
  }

  setSpeaker(pos: Pos | null): void {
    this.speaker = pos;
  }

  setPlayer(pos: Pos | null): void {
    this.player = pos;
  }

  private hideAll(): void {
    for (const e of [this.hover, this.cross, this.exitMark, this.exitArrow, this.exitLabel, this.ring, this.dirs, this.compassEl]) e.setAttribute('visibility', 'hidden');
  }

  private quad(p: Pos, inset = 0.46): string {
    const corners = [
      { x: p.x - inset, y: p.y - inset },
      { x: p.x + inset, y: p.y - inset },
      { x: p.x + inset, y: p.y + inset },
      { x: p.x - inset, y: p.y + inset },
    ];
    const r = this.svg.getBoundingClientRect();
    return corners
      .map((c) => this.project(c))
      .map((s) => `${(s.x - r.left).toFixed(1)},${(s.y - r.top).toFixed(1)}`)
      .join(' ');
  }

  /** re-project everything (call once per animation frame) */
  frame(): void {
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const local = (p: { x: number; y: number }) => {
      const s = this.project(p);
      return { x: s.x - r.left, y: s.y - r.top };
    };
    const pv = this.preview;
    if (pv) {
      this.hover.setAttribute('points', this.quad(pv.pos));
      this.hover.setAttribute('visibility', 'visible');
      this.hover.setAttribute('class', `ov-hover kind-${pv.kind}`);
      if (pv.kind === 'none') {
        const c = local(pv.pos);
        const d = 7;
        this.cross.setAttribute('d', `M ${c.x - d} ${c.y - d} L ${c.x + d} ${c.y + d} M ${c.x + d} ${c.y - d} L ${c.x - d} ${c.y + d}`);
        this.cross.setAttribute('visibility', 'visible');
      } else this.cross.setAttribute('visibility', 'hidden');
      const n = Math.min(MAX_DOTS, Math.max(0, pv.path.length - 1));
      for (let i = 0; i < n; i++) {
        const c = local(pv.path[i]);
        const dot = this.dotEls[i];
        dot.setAttribute('cx', c.x.toFixed(1));
        dot.setAttribute('cy', c.y.toFixed(1));
        dot.setAttribute('opacity', String(Math.max(0.25, 0.85 - i * 0.02)));
      }
    } else {
      this.hover.setAttribute('visibility', 'hidden');
      this.cross.setAttribute('visibility', 'hidden');
    }

    // the speaker you are talking to
    if (this.speaker) {
      const c = local(this.speaker);
      const e = local({ x: this.speaker.x + 0.5, y: this.speaker.y });
      const rx = Math.max(10, Math.abs(e.x - c.x) * 1.05);
      this.ring.setAttribute('cx', c.x.toFixed(1));
      this.ring.setAttribute('cy', c.y.toFixed(1));
      this.ring.setAttribute('rx', rx.toFixed(1));
      this.ring.setAttribute('ry', (rx * 0.55).toFixed(1));
      this.ring.setAttribute('visibility', 'visible');
    } else this.ring.setAttribute('visibility', 'hidden');

    this.drawAim(local);
    this.drawCompass(local);

    // the area exit: a marker on it, or an arrow at the screen edge while it is off screen
    if (this.exit) {
      const at = local(this.exit.pos);
      const from = this.player ? local(this.player) : { x: r.width / 2, y: r.height / 2 };
      const arrow = edgeArrow(from, at, { w: r.width, h: r.height });
      if (arrow) {
        this.exitMark.setAttribute('visibility', 'hidden');
        const lines = Math.max(1, this.labelLines.length);
        const longest = Math.max(0, ...this.labelLines.map((l) => l.length));
        const size = { w: longest * 6.4 + 6, h: lines * 13 + 4 };
        const obstacles = this.avoid()
          .filter((d) => d.width > 0 && d.height > 0)
          .map((d) => ({ x: d.left - r.left - 6, y: d.top - r.top - 6, w: d.width + 12, h: d.height + 12 }));
        const pl = placeEdgeMarker(arrow, at, size, obstacles, { w: r.width, h: r.height });
        this.exitArrow.setAttribute('transform', `translate(${pl.x.toFixed(1)} ${pl.y.toFixed(1)}) rotate(${pl.angle.toFixed(1)})`);
        this.exitArrow.setAttribute('visibility', 'visible');
        const lx = Math.max(8, Math.min(r.width - 8, pl.label.x));
        // tspans step down 1.15em each, so the text block starts one line above its box top
        const ly = pl.label.rect.y - 2;
        this.exitLabel.setAttribute('text-anchor', pl.label.anchor);
        this.exitLabel.setAttribute('x', lx.toFixed(1));
        this.exitLabel.setAttribute('y', ly.toFixed(1));
        for (const t of Array.from(this.exitLabel.children)) t.setAttribute('x', lx.toFixed(1));
        this.exitLabel.setAttribute('visibility', 'visible');
      } else {
        this.exitArrow.setAttribute('visibility', 'hidden');
        this.exitLabel.setAttribute('visibility', 'hidden');
        this.exitMark.setAttribute('points', this.quad(this.exit.pos, 0.42));
        this.exitMark.setAttribute('visibility', 'visible');
      }
    } else {
      this.exitMark.setAttribute('visibility', 'hidden');
      this.exitArrow.setAttribute('visibility', 'hidden');
      this.exitLabel.setAttribute('visibility', 'hidden');
    }
  }

  private drawCompass(local: (p: { x: number; y: number }) => { x: number; y: number }): void {
    const goal = this.compass;
    const p = this.player;
    const dx = goal && p ? goal.x - p.x : 0;
    const dy = goal && p ? goal.y - p.y : 0;
    if (!goal || !p || (dx === 0 && dy === 0) || this.aim) {
      this.compassEl.setAttribute('visibility', 'hidden');
      return;
    }
    // map-space direction, projected so it follows the camera's tilt and rotation
    const len = Math.hypot(dx, dy);
    const c = local(p);
    const n = local({ x: p.x + (dx / len) * COMPASS_RADIUS, y: p.y + (dy / len) * COMPASS_RADIUS });
    const angle = (Math.atan2(n.y - c.y, n.x - c.x) * 180) / Math.PI;
    this.compassEl.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
    this.compassEl.setAttribute('visibility', 'visible');
  }

  private drawAim(local: (p: { x: number; y: number }) => { x: number; y: number }): void {
    const aim = this.aim;
    if (!aim) {
      this.dirs.setAttribute('visibility', 'hidden');
      return;
    }
    const c = local(aim.from);
    const sx = Math.sign(aim.at.x - aim.from.x);
    const sy = Math.sign(aim.at.y - aim.from.y);
    DIRS8.forEach(([dx, dy], i) => {
      const n = local({ x: aim.from.x + dx * 0.78, y: aim.from.y + dy * 0.78 });
      const angle = (Math.atan2(n.y - c.y, n.x - c.x) * 180) / Math.PI;
      const p = this.dirEls[i];
      p.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
      p.setAttribute('class', dx === sx && dy === sy ? 'is-on' : '');
    });
    this.dirs.setAttribute('visibility', 'visible');
  }

  dispose(): void {
    this.svg.remove();
  }
}
