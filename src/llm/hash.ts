/** Stable request hashing for recordings (browser + Node, synchronous, no crypto dependency). */
import type { CompletionRequest } from './types';

/** JSON.stringify with sorted object keys */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex chars */
export function fnv1a64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Hash of the parts of a request that determine the answer: system, messages, schema name and schema.
 * Excludes signal, maxTokens, temperature and purpose (purpose is the separate lookup key).
 */
export function requestHash(req: CompletionRequest): string {
  return fnv1a64(
    stableStringify({
      system: req.system,
      messages: req.messages,
      schemaName: req.schemaName,
      jsonSchema: req.jsonSchema,
    }),
  );
}
