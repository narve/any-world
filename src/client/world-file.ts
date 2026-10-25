/**
 * World files (DESIGN §12, a first cheap step toward sharing): a World Spec saved as a JSON file and
 * loaded back. The file wraps the spec with a small header so a future version can add a seed, a
 * run summary or a share code without breaking old files:
 *
 *   { "format": "anyworld-world", "version": 1, "exportedAt": "2026-10-24T…Z", "world": { …WorldSpec… } }
 *
 * A bare WorldSpec (e.g. content/worlds/*.json) imports too. Imported files are untrusted input: the
 * text is size-limited, parsed, and the spec re-validated with parseWorld (zod + cross references),
 * which also drops unknown keys. The world keeps its own `meta.language`.
 *
 * Pure (no DOM): the browser download/upload glue lives in main.ts.
 */
import { parseWorld } from '../schema/refs';
import { MAX_JSON_DEPTH, jsonDepth } from '../schema/json-depth';
import type { WorldSpec } from '../schema/world';
import { slugify } from '../llm/recording-keys';

export const WORLD_FILE_FORMAT = 'anyworld-world';
export const WORLD_FILE_VERSION = 1;
/**
 * A generous ceiling: recorded worlds are 40–140 kB. Kept well under the ~5 MB localStorage quota,
 * so one untrusted file cannot push every other kept world out (issues/M5-stored-world-evicts-saved-run.md).
 */
export const MAX_WORLD_FILE_BYTES = 600_000;

export interface WorldFile {
  format: typeof WORLD_FILE_FORMAT;
  version: typeof WORLD_FILE_VERSION;
  exportedAt: string;
  world: WorldSpec;
}

/** the file name and JSON text for a world */
export function exportWorldFile(world: WorldSpec, now: Date = new Date()): { filename: string; text: string } {
  const file: WorldFile = { format: WORLD_FILE_FORMAT, version: WORLD_FILE_VERSION, exportedAt: now.toISOString(), world };
  const slug = slugify(world.meta.title).slice(0, 48) || 'world';
  return { filename: `${slug}.anyworld.json`, text: `${JSON.stringify(file, null, 2)}\n` };
}

/** why an import failed; `key` is an i18n catalog key (world.import.error.*) */
export type WorldImportError =
  | { kind: 'too_large'; key: 'world.import.error.tooLarge'; details: string[] }
  | { kind: 'not_json'; key: 'world.import.error.notJson'; details: string[] }
  | { kind: 'not_world'; key: 'world.import.error.notWorld'; details: string[] }
  | { kind: 'newer_version'; key: 'world.import.error.newer'; details: string[] }
  | { kind: 'invalid'; key: 'world.import.error.invalid'; details: string[] };

export type WorldImportResult = { ok: true; world: WorldSpec } | ({ ok: false } & WorldImportError);

function fail<K extends WorldImportError['kind']>(kind: K, details: string[] = []): WorldImportResult {
  const keys: Record<WorldImportError['kind'], WorldImportError['key']> = {
    too_large: 'world.import.error.tooLarge',
    not_json: 'world.import.error.notJson',
    not_world: 'world.import.error.notWorld',
    newer_version: 'world.import.error.newer',
    invalid: 'world.import.error.invalid',
  };
  return { ok: false, kind, key: keys[kind], details } as WorldImportResult;
}

/** byte length of a string as UTF-8 (no TextEncoder needed) */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export { MAX_JSON_DEPTH, jsonDepth };

/** parses and re-validates a world file (wrapped or a bare WorldSpec) */
export function parseWorldFile(text: string): WorldImportResult {
  if (typeof text !== 'string') return fail('not_json');
  if (text.length > MAX_WORLD_FILE_BYTES || utf8Bytes(text) > MAX_WORLD_FILE_BYTES) return fail('too_large', [`${Math.round(utf8Bytes(text) / 1000)} kB`]);
  let json: unknown;
  try {
    // a UTF-8 BOM is common in files saved by editors on Windows
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return fail('not_json', [e instanceof Error ? e.message : String(e)]);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('not_world');
  const o = json as Record<string, unknown>;
  let spec: unknown = json;
  if ('format' in o || 'world' in o) {
    if (o.format !== WORLD_FILE_FORMAT || !o.world || typeof o.world !== 'object') return fail('not_world');
    if (typeof o.version === 'number' && o.version > WORLD_FILE_VERSION) return fail('newer_version', [`version ${o.version}`]);
    spec = o.world;
  }
  const s = spec as Record<string, unknown>;
  if (!s.meta || typeof s.meta !== 'object' || !('specVersion' in s)) return fail('not_world');
  if (typeof s.specVersion === 'number' && s.specVersion > 1) return fail('newer_version', [`specVersion ${s.specVersion}`]);
  const depth = jsonDepth(spec, MAX_JSON_DEPTH);
  if (depth > MAX_JSON_DEPTH) return fail('invalid', [`nested too deeply (more than ${MAX_JSON_DEPTH} levels)`]);
  let r: ReturnType<typeof parseWorld>;
  try {
    r = parseWorld(spec);
  } catch (e) {
    // any other failure inside validation is still a typed "invalid", never an uncaught throw
    return fail('invalid', [e instanceof RangeError ? 'nested too deeply' : e instanceof Error ? e.message : String(e)]);
  }
  if (!r.ok) return fail('invalid', r.errors.slice(0, 8));
  return { ok: true, world: r.world };
}
