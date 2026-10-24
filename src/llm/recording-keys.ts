/**
 * Recording keys (M3). Recorded LLM responses live in content/recordings/<worldKey>/*.json and are
 * looked up by the MockProvider through scoped purposes:
 *
 *   world                                   world generation (content/worlds holds the result)
 *   gm:<hook>/<worldKey>/a<area>            one GM moment, e.g. "gm:area_enter/fixture-ship/a1"
 *   dialogue/<worldKey>/<npcDefId>          one NPC's conversation turns, served in order
 *
 * The mock tries the full key, then drops trailing segments ("gm:area_enter/fixture-ship", …), so a
 * recording may be as specific as it likes. Real providers see the same purpose (logs only).
 * Browser-safe.
 */
import type { GmHook } from '../schema/gm';
import type { WorldSpec } from '../schema/world';

const FOLD: Record<string, string> = { æ: 'ae', ø: 'o', å: 'a', ß: 'ss', œ: 'oe', þ: 'th', ð: 'd', ł: 'l' };

/** ASCII kebab-case slug ("Lowmoor Goes Under" → "lowmoor-goes-under", "Ærlig Øy" → "aerlig-oy") */
export function slugify(text: string, max = 40): string {
  const folded = text
    .toLowerCase()
    .replace(/[æøåßœþðł]/g, (c) => FOLD[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}

/** the key a world's recordings and its content/worlds file are stored under (from its title) */
export function worldKeyOf(world: Pick<WorldSpec, 'meta'>): string {
  return slugify(world.meta.title) || 'world';
}

/** keep a caller-given key (a bundled world's file id) safe for paths and purposes */
export function safeKey(key: string): string {
  return slugify(key, 40) || 'world';
}

export function gmPurpose(hook: GmHook, worldKey: string, area: number): string {
  return `gm:${hook}/${safeKey(worldKey)}/a${Math.max(0, Math.floor(area))}`;
}

export function dialoguePurpose(worldKey: string, npcDefId: string): string {
  return `dialogue/${safeKey(worldKey)}/${npcDefId.slice(0, 48)}`;
}

export const WORLD_PURPOSE = 'world';

/** recordings file name inside content/recordings/<worldKey>/ for a purpose */
export function recordingFileName(purpose: string): string {
  const [head, , ...rest] = purpose.split('/');
  const base = head!.replace(/:/g, '-');
  return `${[base, ...rest].join('-').replace(/[^a-z0-9_-]+/gi, '-')}.json`;
}
