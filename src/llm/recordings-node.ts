/**
 * Node-only: load recorded LLM responses from a directory (default content/recordings), including
 * its per-world subdirectories (content/recordings/<worldKey>/*.json, see recording-keys.ts).
 * Every *.json file may hold one recording, an array, or {recordings: [...]} (see mock.ts).
 * Kept separate from mock.ts so the browser bundle never imports node:fs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRecordingsFile, type Recording } from './mock';

export interface LoadRecordingsOptions {
  /** descend into subdirectories (default true) */
  recursive?: boolean;
  /** only this subdirectory (a world key) plus the top-level files */
  worldKey?: string;
}

export async function loadRecordingsFromDir(dir = 'content/recordings', opts: LoadRecordingsOptions = {}): Promise<Recording[]> {
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: Recording[] = [];
  for (const e of entries) {
    if (e.dir || !e.name.endsWith('.json')) continue;
    const raw = await readFile(join(dir, e.name), 'utf8');
    try {
      out.push(...parseRecordingsFile(JSON.parse(raw)));
    } catch (err) {
      throw new Error(`recordings: ${e.name} is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (opts.recursive === false) return out;
  for (const e of entries) {
    if (!e.dir || e.name.startsWith('.')) continue;
    if (opts.worldKey && e.name !== opts.worldKey) continue;
    out.push(...(await loadRecordingsFromDir(join(dir, e.name), { recursive: true })));
  }
  return out;
}
