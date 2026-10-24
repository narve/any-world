/**
 * Node-only: load recorded LLM responses from a directory (default content/recordings).
 * Every *.json file may hold one recording, an array, or {recordings: [...]} (see mock.ts).
 * Kept separate from mock.ts so the browser bundle never imports node:fs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRecordingsFile, type Recording } from './mock';

export async function loadRecordingsFromDir(dir = 'content/recordings'): Promise<Recording[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: Recording[] = [];
  for (const n of names) {
    const raw = await readFile(join(dir, n), 'utf8');
    try {
      out.push(...parseRecordingsFile(JSON.parse(raw)));
    } catch (e) {
      throw new Error(`recordings: ${n} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return out;
}
