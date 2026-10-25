/**
 * Nesting guard for untrusted JSON (imported world files, LLM replies). zod's recursive schemas
 * recurse on the call stack, so a small hostile value nesting thousands of `not` conditions would
 * throw RangeError (issues/M5-import-deep-nesting.md). The deepest nesting real worlds use is well
 * under 10 levels of conditions (~20 JSON levels with the wrappers).
 */
export const MAX_JSON_DEPTH = 64;

/** the nesting depth of a parsed JSON value, walked iteratively (stops counting past `limit`) */
export function jsonDepth(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (!v || typeof v !== 'object') continue;
    if (d > max) max = d;
    if (max > limit) return max;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
      if (child && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
  return max;
}
