import type { AreaPlan } from '../../schema/world';
import type { Rng } from '../types';
import { Grid, clamp } from './grid';
import { PARTY_SCALING, clampPartySize, partyFactor } from '../difficulty';

export type MapSize = 'small' | 'medium' | 'large';

export const MAP_SIZES: Record<MapSize, { width: number; height: number }> = {
  small: { width: 32, height: 24 },
  medium: { width: 44, height: 32 },
  large: { width: 56, height: 40 },
};

export interface GenContext {
  g: Grid;
  rng: Rng;
  size: MapSize;
  /** numeric knob lookup with aliases, default and clamping */
  param(names: string | string[], def: number, lo: number, hi: number): number;
  /** voronoi region granularity (tiles per region) for generators without natural rooms; 0 = off */
  voronoi: number;
  /** components smaller than this are filled instead of connected */
  dropBelow: number;
  /** connectivity repair may turn single carved wall tiles into doors (off for natural maps) */
  carveDoors: boolean;
  /**
   * Leave the edges of the playable shape open to the void (no wall rim). Used by floating
   * layouts (islands) whose platforms end in a drop rather than a wall.
   */
  openEdges: boolean;
  /**
   * Structural, genre-neutral names for generator regions (e.g. "platform", "chamber",
   * "ring 2"); copied onto AreaMap.regions[].name so discovery hooks can describe them.
   */
  regionNames: Map<number, string>;
  /**
   * Fewer dead ends (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §3.4): layers of corridor spurs that
   * lead nowhere to fill, and loops to cut through thin walls where the walk around is longest.
   * Both 0 for layouts whose dead ends or symmetry are the point (islands' pockets, geometric).
   */
  pruneSpurs: number;
  shortcuts: number;
  /**
   * How many times the MAP_SIZES area this grid has (1 for a single player, ≈2.6 for 12 players).
   * Generators that place a fixed number of fixed-size features (rooms, buildings) multiply their
   * count by it (scaledCount), so a party's bigger map is not mostly void.
   */
  areaScale: number;
}

/** a feature count for the grid's size: `n` for a single player's map, else n × areaScale, rounded */
export function scaledCount(ctx: Pick<GenContext, 'areaScale'>, n: number): number {
  return ctx.areaScale > 1 ? Math.round(n * ctx.areaScale) : n;
}

/**
 * Width and height of a map of `size` for a party of `partySize`: MAP_SIZES, with width and height
 * each scaled by √(1 + PARTY_SCALING.mapArea·(n − 1)), rounded (about +15 % area per extra
 * player; 12 players: large 56×40 → 91×65). A party of one gets MAP_SIZES as they are.
 */
export function mapDimensions(size: MapSize, partySize = 1): { width: number; height: number } {
  const base = MAP_SIZES[size];
  const n = clampPartySize(partySize);
  if (n <= 1) return { width: base.width, height: base.height };
  const k = Math.sqrt(partyFactor(n, PARTY_SCALING.mapArea));
  return { width: Math.round(base.width * k), height: Math.round(base.height * k) };
}

/**
 * The generator context for a plan; `partySize` grows the grid (mapDimensions). Knobs derived from
 * `size` (shortcuts, spurs, most counts) keep their small/medium/large values; only fixed-size
 * features (rooms, town buildings) grow in number with the grid (areaScale).
 */
export function makeContext(plan: Pick<AreaPlan, 'size' | 'params'>, rng: Rng, partySize = 1): GenContext {
  const size: MapSize = plan.size === 'small' || plan.size === 'large' ? plan.size : 'medium';
  const { width, height } = mapDimensions(size, partySize);
  const base = MAP_SIZES[size];
  const areaScale = width === base.width && height === base.height ? 1 : (width * height) / (base.width * base.height);
  const params: Record<string, number> = plan.params ?? {};
  return {
    g: new Grid(width, height, 'void'),
    rng,
    size,
    voronoi: 0,
    dropBelow: 0,
    carveDoors: true,
    openEdges: false,
    regionNames: new Map(),
    areaScale,
    pruneSpurs: Math.round(clamp(typeof params.spurs === 'number' ? params.spurs : 12, 0, 40)),
    shortcuts: Math.round(clamp(typeof params.shortcuts === 'number' ? params.shortcuts : { small: 3, medium: 5, large: 7 }[size], 0, 20)),
    param(names, def, lo, hi) {
      for (const n of Array.isArray(names) ? names : [names]) {
        const v = params[n];
        if (typeof v === 'number' && Number.isFinite(v)) return clamp(v, lo, hi);
      }
      return def;
    },
  };
}

/** small/medium/large lookup */
export function bySize<T>(size: MapSize, small: T, medium: T, large: T): T {
  return size === 'small' ? small : size === 'large' ? large : medium;
}

/** inclusive integer rectangle (interior of a room) */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
