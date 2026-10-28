/**
 * Boot routing: what the app does for the URL it was opened with, given the autosaved run.
 * Pure (no DOM, no storage) so the rules can be unit-tested — see issues/M1-reload-wipes-run.md.
 *
 * Rules:
 *  - `?room=<code>` (MP3) opens that room; the code is upper-cased and must be a valid room code (else
 *    the start screen). It wins over `?world=`, and the saved single-player run is never touched.
 *  - `?world=<id>[&seed=<n>]` starts that world, unless an autosaved run of the same world (and,
 *    when the link names a seed, the same seed) exists: then the run is resumed. Reloading a page
 *    opened from a demo link therefore continues the run instead of wiping it.
 *  - `?world=` while a run of a *different* world/seed is saved never discards that run without
 *    asking: the start screen opens (it offers "Continue" and the demo worlds) with a notice.
 *  - `?continue=1` resumes the autosaved run (the start screen when there is none).
 *  - anything else opens the start screen.
 */
import { t } from './i18n/index';
import { Code } from '../net/protocol';

export interface SavedRunInfo {
  worldId: string;
  worldTitle: string;
  /** engine seed of the saved run; older saves have none */
  seed?: number;
}

export type BootRoute =
  | { kind: 'new'; worldId: string; seed?: number }
  | { kind: 'continue' }
  | { kind: 'room'; code: string }
  | { kind: 'start'; notice?: string };

/** parses `seed=` the way demo links write it: a positive integer, else none */
export function parseSeed(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) >>> 0 || undefined : undefined;
}

export function bootRoute(search: string, saved: SavedRunInfo | null, worldTitle?: (id: string) => string | undefined): BootRoute {
  const q = new URLSearchParams(search);
  const room = q.get('room');
  if (room !== null) {
    const code = room.trim().toUpperCase();
    return Code.safeParse(code).success ? { kind: 'room', code } : { kind: 'start' };
  }
  const world = q.get('world');
  if (world) {
    const seed = parseSeed(q.get('seed'));
    if (!saved) return seed === undefined ? { kind: 'new', worldId: world } : { kind: 'new', worldId: world, seed };
    const sameWorld = saved.worldId === world;
    const sameSeed = seed === undefined || saved.seed === undefined || saved.seed === seed;
    if (sameWorld && sameSeed) return { kind: 'continue' };
    const title = worldTitle?.(world) ?? world;
    return {
      kind: 'start',
      notice: t('boot.runInProgress', { saved: saved.worldTitle, title }),
    };
  }
  if (q.get('continue') === '1') return saved ? { kind: 'continue' } : { kind: 'start' };
  return { kind: 'start' };
}

/** the address bar for a run on screen: reloading it (or sharing it) gets back to the same run */
export function runUrl(worldId: string, seed: number): string {
  const q = new URLSearchParams({ world: worldId, seed: String(seed >>> 0) });
  return `?${q.toString()}`;
}
