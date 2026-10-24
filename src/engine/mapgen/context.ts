import type { AreaPlan } from '../../schema/world';
import type { Rng } from '../types';
import { Grid, clamp } from './grid';

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
}

export function makeContext(plan: Pick<AreaPlan, 'size' | 'params'>, rng: Rng): GenContext {
  const size: MapSize = plan.size === 'small' || plan.size === 'large' ? plan.size : 'medium';
  const { width, height } = MAP_SIZES[size];
  const params: Record<string, number> = plan.params ?? {};
  return {
    g: new Grid(width, height, 'void'),
    rng,
    size,
    voronoi: 0,
    dropBelow: 0,
    carveDoors: true,
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
