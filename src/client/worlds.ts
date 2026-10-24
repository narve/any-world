/// <reference types="vite/client" />
/**
 * Worlds the client can play: the recorded worlds bundled with the client (content/worlds/*.json)
 * and AI-generated worlds kept in localStorage (storage.ts). Each is validated with parseWorld on
 * first use; invalid ones are skipped with a console warning.
 */
import { parseWorld } from '../schema/refs';
import type { WorldSpec } from '../schema/world';
import { loadGeneratedWorlds, saveGeneratedWorld } from './storage';
import { slugify } from '../llm/recording-keys';

const raw = import.meta.glob('../../content/worlds/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export interface WorldEntry {
  id: string;
  world: WorldSpec;
  /** made by the AI for this player (not bundled) */
  generated?: boolean;
}

let cache: WorldEntry[] | null = null;

export function bundledWorlds(): WorldEntry[] {
  if (cache) return cache;
  const out: WorldEntry[] = [];
  for (const [path, json] of Object.entries(raw)) {
    const id = path.split('/').pop()!.replace(/\.json$/, '');
    const r = parseWorld(json);
    if (r.ok) out.push({ id, world: r.world });
    else console.warn(`[anyworld] world ${id} failed to validate:`, r.errors.slice(0, 5));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  cache = out;
  return out;
}

/** AI-generated worlds kept in this browser, newest last */
export function generatedWorlds(): WorldEntry[] {
  const out: WorldEntry[] = [];
  for (const s of loadGeneratedWorlds()) {
    const r = parseWorld(s.world);
    if (r.ok) out.push({ id: s.id, world: r.world, generated: true });
    else console.warn(`[anyworld] stored world ${s.id} failed to validate:`, r.errors.slice(0, 5));
  }
  return out;
}

export function findWorld(id: string): WorldEntry | undefined {
  return bundledWorlds().find((w) => w.id === id) ?? (id.startsWith(GENERATED_PREFIX) ? generatedWorlds().find((w) => w.id === id) : undefined);
}

/** ids of generated worlds start with this (never clashes with a bundled file id) */
export const GENERATED_PREFIX = 'gen-';

/** an id for a generated world: prefix + title slug + `nonce` in base 36 (the caller passes a random nonce) */
export function generatedWorldId(world: WorldSpec, nonce: number): string {
  const slug = slugify(world.meta.title).slice(0, 40) || 'world';
  return `${GENERATED_PREFIX}${slug}-${(nonce >>> 0).toString(36)}`;
}

/** keeps a generated world so its run can be resumed; returns its entry */
export function rememberWorld(world: WorldSpec, nonce: number): WorldEntry {
  const id = generatedWorldId(world, nonce);
  if (!saveGeneratedWorld(id, world)) console.warn('[anyworld] could not store the generated world; a reload will not resume it');
  return { id, world, generated: true };
}
