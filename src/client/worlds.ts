/// <reference types="vite/client" />
/**
 * Recorded worlds bundled with the client (content/worlds/*.json). Each is validated with
 * parseWorld on first use; invalid files are skipped with a console warning.
 */
import { parseWorld } from '../schema/refs';
import type { WorldSpec } from '../schema/world';

const raw = import.meta.glob('../../content/worlds/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export interface WorldEntry {
  id: string;
  world: WorldSpec;
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

export function findWorld(id: string): WorldEntry | undefined {
  return bundledWorlds().find((w) => w.id === id);
}
