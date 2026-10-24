/**
 * Helpers for sending JSON Schemas to providers: sanitising for native structured output,
 * detecting recursive schemas, and the prompt-only fallback instruction.
 */

/** keywords Anthropic structured outputs reject; they are still enforced client-side by zod */
const ANTHROPIC_UNSUPPORTED = new Set([
  '$schema',
  '$id',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'default',
  'examples',
]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** keys whose value is a map of user-chosen names to subschemas (not keywords) */
const NAME_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);

function isObjectNode(node: Record<string, Json>): boolean {
  return (
    node.type === 'object' ||
    (Array.isArray(node.type) && node.type.includes('object')) ||
    (node.type === undefined && (node.properties !== undefined || node.additionalProperties !== undefined))
  );
}

/**
 * JSON-pointer paths of the "open" object nodes in `schema`: maps/records (z.record, catchall),
 * objects with `patternProperties`, and bare `{type:"object"}` nodes that declare no properties.
 * Anthropic structured outputs require `additionalProperties: false` on every object, so such a node
 * cannot be expressed natively: closing it would force the model to emit `{}`.
 */
export function findOpenObjects(schema: object): string[] {
  const found: string[] = [];
  const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
  const walk = (node: Json, path: string, key?: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}/${i}`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (key !== undefined && NAME_MAPS.has(key)) {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${esc(k)}`);
      return;
    }
    if (isObjectNode(node)) {
      const ap = node.additionalProperties;
      const props = node.properties;
      const hasProps = !!props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length > 0;
      const schemaValuedAp = !!ap && typeof ap === 'object';
      const openAp = ap === undefined || ap === true;
      if (schemaValuedAp || node.patternProperties !== undefined || (openAp && !hasProps)) found.push(path || '#');
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'enum' || k === 'const' || k === 'default' || k === 'examples') continue;
      walk(v, `${path}/${esc(k)}`, k);
    }
  };
  walk(JSON.parse(JSON.stringify(schema)) as Json, '');
  return found;
}

/**
 * true when `schema` can be sent as Anthropic `output_config.format` without changing its meaning:
 * not recursive and no open objects (records). Otherwise callers use prompt-only JSON + zod.
 */
export function supportsAnthropicNativeSchema(schema: object): boolean {
  return !isRecursiveSchema(schema) && findOpenObjects(schema).length === 0;
}

/**
 * Return a copy of `schema` suitable for Anthropic `output_config.format`: unsupported constraint
 * keywords removed, every object closed with `additionalProperties: false`, `minItems` > 1 dropped.
 * Throws for schemas containing open objects (records / maps; see `findOpenObjects`): closing them
 * would silently restrict the model to `{}`. Check `supportsAnthropicNativeSchema` first.
 */
export function sanitizeSchemaForAnthropic(schema: object): object {
  const open = findOpenObjects(schema);
  if (open.length) {
    throw new Error(
      `sanitizeSchemaForAnthropic: schema has open objects (records/maps) that Anthropic structured outputs cannot express: ${open.slice(0, 5).join(', ')}`,
    );
  }
  const walk = (node: Json, key?: string): Json => {
    if (Array.isArray(node)) return node.map((n) => walk(n));
    if (!node || typeof node !== 'object') return node;
    // inside "properties" / "$defs" the keys are user names, not keywords
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      if (ANTHROPIC_UNSUPPORTED.has(k)) continue;
      if (k === 'minItems' && typeof v === 'number' && v > 1) continue;
      // only `false` / `true` / absent reach here (schema-valued ones were rejected above); re-added below
      if (k === 'additionalProperties') continue;
      out[k] = k === 'enum' || k === 'const' ? v : walk(v, k);
    }
    if (isObjectNode(node)) out.additionalProperties = false;
    return out;
  };
  return walk(JSON.parse(JSON.stringify(schema)) as Json) as object;
}

/** true if the schema's $defs reference themselves (directly or indirectly) */
export function isRecursiveSchema(schema: object): boolean {
  const root = schema as { $defs?: Record<string, unknown>; definitions?: Record<string, unknown> };
  const defs: Record<string, unknown> = { ...(root.definitions ?? {}), ...(root.$defs ?? {}) };
  const refsOf = (node: unknown, acc: Set<string>): Set<string> => {
    if (Array.isArray(node)) node.forEach((n) => refsOf(n, acc));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          if (v === '#') acc.add('#');
          const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(v);
          if (m) acc.add(decodeURIComponent(m[1]!.replace(/~1/g, '/').replace(/~0/g, '~')));
        } else refsOf(v, acc);
      }
    }
    return acc;
  };
  const graph = new Map<string, Set<string>>();
  for (const [name, def] of Object.entries(defs)) graph.set(name, refsOf(def, new Set()));
  // a reference to the root ("#") from anywhere is recursion
  const rootRefs = refsOf({ ...schema, $defs: undefined, definitions: undefined }, new Set());
  if (rootRefs.has('#')) return true;
  for (const r of graph.values()) if (r.has('#')) return true;
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    const s = state.get(n);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(n, 1);
    for (const m of graph.get(n) ?? []) if (graph.has(m) && visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  for (const n of graph.keys()) if (visit(n)) return true;
  return false;
}

/** schemas larger than this are not pasted into prompts by default */
export const MAX_PROMPT_SCHEMA_CHARS = 24_000;

/**
 * System-prompt suffix for providers without native schema enforcement.
 * Always demands a single bare JSON value; includes the schema when it is small enough
 * (or when `schemaInPrompt` is explicitly true).
 */
export function jsonInstruction(jsonSchema: object | undefined, schemaInPrompt?: boolean): string {
  const lines = ['', '', 'Respond with a single valid JSON value only: no prose, no markdown code fences.'];
  if (jsonSchema) {
    const text = JSON.stringify(jsonSchema);
    const include = schemaInPrompt ?? text.length <= MAX_PROMPT_SCHEMA_CHARS;
    if (include) lines.push('The JSON must conform to this JSON Schema:', text);
  }
  return lines.join('\n');
}
