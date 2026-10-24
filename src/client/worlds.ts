/// <reference types="vite/client" />
/**
 * Worlds the client can play: the recorded worlds bundled with the client (content/worlds/*.json)
 * and AI-made or imported worlds kept in localStorage (storage.ts).
 *
 * Bundled worlds are split in two so the first load stays small (DESIGN §6b): a light, synchronous
 * index (each file's `meta` and `palette`, for the start screen, boot routing and the offline demo
 * generator) and the full specs, each a lazy chunk fetched and validated with parseWorld when that
 * world is played (`loadWorld`). Stored worlds are read from localStorage and validated on use.
 * Invalid worlds are skipped with a console warning.
 */
import { parseWorld } from '../schema/refs';
import type { WorldMeta, WorldSpec } from '../schema/world';
import { forgetGeneratedWorld, loadGeneratedWorlds, saveGeneratedWorld, type StoredWorldMeta } from './storage';
import { slugify } from '../llm/recording-keys';

// Vite exposes a JSON file's top-level keys as named exports: these two eager globs keep only
// `meta` and `palette` in the main chunk. The full files are loaded as `?raw` text — separate
// modules, one lazy chunk each — so the eager imports above do not pull them in.
const metas = import.meta.glob('../../content/worlds/*.json', { eager: true, import: 'meta' }) as Record<string, unknown>;
const palettes = import.meta.glob('../../content/worlds/*.json', { eager: true, import: 'palette' }) as Record<string, unknown>;
const specs = import.meta.glob('../../content/worlds/*.json', { query: '?raw', import: 'default' }) as Record<string, () => Promise<unknown>>;

export interface WorldEntry {
  id: string;
  world: WorldSpec;
  /** made by the AI for this player, or imported from a file (not bundled) */
  generated?: boolean;
  /** kept in this browser: how it got here (M4) */
  source?: 'generated' | 'imported';
  /** bundled world it was copied from (offline demo generator): recordings key for demo GM lines */
  origin?: string;
  /** epoch ms it was kept */
  savedAt?: number;
}

/** what the start screen needs to list a bundled world, without loading it */
export interface WorldIndexEntry {
  id: string;
  meta: Pick<WorldMeta, 'title' | 'tagline' | 'genre' | 'language' | 'tags' | 'tone' | 'premise' | 'prompt'>;
  /** palette.primary */
  color?: string;
}

const idOf = (path: string) => path.split('/').pop()!.replace(/\.json$/, '').replace(/\?.*$/, '');
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

let index: WorldIndexEntry[] | null = null;

/** every bundled world, by id (sorted), from the light index */
export function worldIndex(): WorldIndexEntry[] {
  if (index) return index;
  const out: WorldIndexEntry[] = [];
  for (const [path, m] of Object.entries(metas)) {
    if (!m || typeof m !== 'object') continue;
    const meta = m as Record<string, unknown>;
    const pal = palettes[path] as { primary?: unknown } | undefined;
    out.push({
      id: idOf(path),
      meta: {
        title: str(meta.title, idOf(path)),
        tagline: str(meta.tagline),
        genre: str(meta.genre),
        language: str(meta.language, 'en') || 'en',
        tags: Array.isArray(meta.tags) ? meta.tags.filter((x): x is string => typeof x === 'string') : [],
        tone: str(meta.tone),
        premise: str(meta.premise),
        prompt: str(meta.prompt),
      },
      ...(typeof pal?.primary === 'string' ? { color: pal.primary } : {}),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  index = out;
  return out;
}

const loaded = new Map<string, Promise<WorldEntry | undefined>>();

/** a bundled world's full spec (fetched once, validated); undefined when missing or invalid */
export function loadBundledWorld(id: string): Promise<WorldEntry | undefined> {
  const hit = loaded.get(id);
  if (hit) return hit;
  const key = Object.keys(specs).find((p) => idOf(p) === id);
  const p = (async (): Promise<WorldEntry | undefined> => {
    if (!key) return undefined;
    let json: unknown;
    try {
      const text = await specs[key]!();
      json = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (e) {
      console.warn(`[anyworld] world ${id} could not be loaded:`, e);
      loaded.delete(id); // a failed chunk fetch (offline) may work later
      return undefined;
    }
    const r = parseWorld(json);
    if (r.ok) return { id, world: r.world };
    console.warn(`[anyworld] world ${id} failed to validate:`, r.errors.slice(0, 5));
    return undefined;
  })();
  loaded.set(id, p);
  return p;
}

/** every bundled world, loaded and validated (tools, the offline demo generator) */
export async function bundledWorlds(): Promise<WorldEntry[]> {
  const all = await Promise.all(worldIndex().map((w) => loadBundledWorld(w.id)));
  return all.filter((w): w is WorldEntry => !!w);
}

/** AI-generated / imported worlds kept in this browser, newest last */
export function generatedWorlds(): WorldEntry[] {
  const out: WorldEntry[] = [];
  for (const s of loadGeneratedWorlds()) {
    const r = parseWorld(s.world);
    if (r.ok) out.push({ id: s.id, world: r.world, generated: true, source: s.source ?? 'generated', savedAt: s.savedAt, ...(s.origin ? { origin: s.origin } : {}) });
    else console.warn(`[anyworld] stored world ${s.id} failed to validate:`, r.errors.slice(0, 5));
  }
  return out;
}

/** a world kept in this browser (synchronous) */
export function findStoredWorld(id: string): WorldEntry | undefined {
  return id.startsWith(GENERATED_PREFIX) ? generatedWorlds().find((w) => w.id === id) : undefined;
}

/** is there a world with this id (bundled, or kept in this browser)? Synchronous, loads nothing. */
export function hasWorld(id: string): boolean {
  return worldIndex().some((w) => w.id === id) || !!findStoredWorld(id);
}

/** a world's title without loading it (boot routing, notices) */
export function worldTitle(id: string): string | undefined {
  return worldIndex().find((w) => w.id === id)?.meta.title ?? findStoredWorld(id)?.world.meta.title;
}

/** any world by id: bundled (loaded on first use) or kept in this browser */
export async function loadWorld(id: string): Promise<WorldEntry | undefined> {
  return id.startsWith(GENERATED_PREFIX) ? findStoredWorld(id) : loadBundledWorld(id);
}

/** ids of generated worlds start with this (never clashes with a bundled file id) */
export const GENERATED_PREFIX = 'gen-';

/** an id for a generated world: prefix + title slug + `nonce` in base 36 (the caller passes a random nonce) */
export function generatedWorldId(world: WorldSpec, nonce: number): string {
  const slug = slugify(world.meta.title).slice(0, 40) || 'world';
  return `${GENERATED_PREFIX}${slug}-${(nonce >>> 0).toString(36)}`;
}

/** keeps a generated (or imported) world so its run can be resumed; returns its entry */
export function rememberWorld(world: WorldSpec, nonce: number, meta: StoredWorldMeta = {}): WorldEntry {
  const id = generatedWorldId(world, nonce);
  const savedAt = Date.now();
  if (!saveGeneratedWorld(id, world, savedAt, meta)) console.warn('[anyworld] could not store the generated world; a reload will not resume it');
  return { id, world, generated: true, source: meta.source ?? 'generated', savedAt, ...(meta.origin ? { origin: meta.origin } : {}) };
}

/** drops a world kept in this browser (bundled worlds cannot be forgotten) */
export function forgetWorld(id: string): boolean {
  return id.startsWith(GENERATED_PREFIX) && forgetGeneratedWorld(id);
}

/** the key under which a world's recorded GM/dialogue lines are bundled (content/recordings/<key>) */
export function recordingsKey(entry: Pick<WorldEntry, 'id' | 'origin'>): string {
  return entry.origin ?? entry.id;
}
