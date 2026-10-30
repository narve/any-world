/**
 * Demo worlds for rooms (MP2 design §3): the files in content/worlds, read lazily, validated with
 * parseWorld (strict keys, as an upload) and cached by file id.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorld } from '../../src/schema';
import type { WorldSpec } from '../../src/schema/world';
import { worldIdOf } from '../../src/engine/index';
import { DemoId } from '../../src/net/protocol';
import { REPO_ROOT } from '../engine-version';

export interface DemoWorld {
  id: string;
  world: WorldSpec;
  worldId: string;
}

export class DemoWorlds {
  private readonly cache = new Map<string, DemoWorld>();

  constructor(readonly dir = resolve(REPO_ROOT, 'content/worlds')) {}

  /** the demo file ids (without .json), sorted */
  ids(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((id) => DemoId.safeParse(id).success)
      .sort();
  }

  /** the world ids of the demos read so far (they stay in the engine registry) */
  loadedWorldIds(): string[] {
    return [...this.cache.values()].map((d) => d.worldId);
  }

  /** the demo world `id`, or null when there is no such (valid) file */
  get(id: string): DemoWorld | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    if (!DemoId.safeParse(id).success) return null;
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return null;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
    const r = parseWorld(json, { strictKeys: true });
    if (!r.ok) return null;
    const out = { id, world: r.world, worldId: worldIdOf(r.world) };
    this.cache.set(id, out);
    return out;
  }
}
