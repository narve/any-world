/**
 * Structured completions: extract JSON from model text, validate with zod (plus optional extra
 * validators such as validateWorldRefs), and on failure ask the model to repair its output with
 * the readable validation errors. Works with every provider and structured-output mode.
 */
import { MAX_JSON_DEPTH, jsonDepth } from '../schema/json-depth';
import { z } from 'zod';
import type { ChatMessage, CompletionRequest, LLMProvider } from './types';
import { LLMError, LLMInvalidResponseError, type LLMErrorInit } from './errors';
import { formatZodError } from '../schema/refs';
import { stripThinking } from './openai-compatible';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type ExtractResult = { ok: true; value: unknown } | { ok: false; error: string };

/** remove // and /* *\/ comments and trailing commas that sit outside strings */
export function relaxJson(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** substring from `start` to its matching close bracket (string-aware); null if unbalanced */
function balancedFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(s: string): { ok: true; value: unknown } | null {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    /* fall through */
  }
  try {
    return { ok: true, value: JSON.parse(relaxJson(s)) };
  } catch {
    return null;
  }
}

/**
 * Find the JSON value in a model reply: bare JSON, ```json fences, JSON after leading prose or
 * before trailing prose, trailing commas and comments tolerated.
 */
const TRUNCATED =
  'The JSON was incomplete (unbalanced brackets; the reply was probably cut off). Reply with the complete JSON, written more compactly (shorter descriptions, no indentation).';

export function extractJson(raw: string): ExtractResult {
  const text = stripThinking(raw.replace(/^﻿/, '')).trim();
  if (!text) return { ok: false, error: 'The reply was empty.' };
  const direct = tryParse(text);
  if (direct) return direct;
  const fence = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const inner = m[1]!.trim();
    const r = tryParse(inner);
    if (r) return r;
    const start = inner.search(/[{[]/);
    if (start >= 0) {
      const b = balancedFrom(inner, start);
      const rb = b && tryParse(b);
      if (rb) return rb;
    }
  }
  let tries = 0;
  let sawUnbalanced = false;
  for (let i = 0; i < text.length && tries < 50; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    tries++;
    const b = balancedFrom(text, i);
    if (!b) {
      // An unbalanced opener that clearly starts a JSON value (`{"…`, `[{…`) means the reply was cut
      // off: everything after it is nested inside, so a later balanced fragment would be a piece of
      // the real answer, not the answer. Stray braces in prose (`{like this`) keep the scan going.
      if (/^(?:\{\s*["}]|\[\s*[[{"\]\d-])/.test(text.slice(i, i + 64))) return { ok: false, error: TRUNCATED };
      sawUnbalanced = true;
      continue;
    }
    const r = tryParse(b);
    if (r) return r;
  }
  if (sawUnbalanced) return { ok: false, error: TRUNCATED };
  return { ok: false, error: 'The reply did not contain a JSON object.' };
}

export class StructuredOutputError extends LLMError {
  readonly errors: string[];
  readonly lastText: string;
  readonly attempts: number;
  readonly usage: Usage;
  constructor(message: string, data: { errors: string[]; lastText: string; attempts: number; usage: Usage }, init: LLMErrorInit = {}) {
    super('structured', message, init);
    this.name = 'StructuredOutputError';
    this.errors = data.errors;
    this.lastText = data.lastText;
    this.attempts = data.attempts;
    this.usage = data.usage;
  }
}

export interface StructuredOptions<T> {
  /** repair attempts after the first try; default 2 (3 calls total) */
  retries?: number;
  /** extra semantic checks run after zod succeeds; return readable errors (empty = valid) */
  validate?: (value: T) => string[] | Promise<string[]>;
  /** at most this many errors are quoted back to the model; default 30 */
  maxErrorsInRepair?: number;
  /** cap on the echoed previous reply in the repair turn; default 120k chars */
  maxEchoChars?: number;
  /** progress hook (UI "fixing the world…" messages, logs) */
  onAttempt?: (info: { attempt: number; ok: boolean; errors: string[] }) => void;
}

export interface StructuredResult<T> {
  value: T;
  /** number of provider calls made */
  attempts: number;
  usage: Usage;
  /** raw text of the accepted reply */
  text: string;
  model: string;
}

/** JSON Schema for a zod schema, as an LLM should produce it (input side: defaults optional). */
export function toJsonSchema(schema: z.ZodType): object {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as object;
}

export function repairMessage(errors: string[], truncated: boolean, max = 30): string {
  const shown = errors.slice(0, max);
  const more = errors.length > shown.length ? `\n- …and ${errors.length - shown.length} more problems of the same kind` : '';
  const lines = [
    'Your previous reply could not be used. Problems found:',
    ...shown.map((e) => `- ${e}`),
  ];
  let msg = lines.join('\n') + more;
  if (truncated) msg += '\n\nYour reply was cut off by the output limit. Be more concise (shorter descriptions) so the whole JSON fits.';
  msg += '\n\nReply again with the complete, corrected JSON (the whole value, not a patch). Output JSON only.';
  return msg;
}

export type CheckResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * The validation steps of one reply, exactly as completeStructured runs them: find the JSON in the
 * text, parse it with `schema` (zod, defaults applied), then the extra `validate` checks. The errors
 * are the readable lines that `repairMessage` quotes back to the model (tools/agent-provider.ts
 * uses this to show agents the same feedback an LLM would get).
 */
export async function checkStructuredText<T>(
  text: string,
  schema: z.ZodType<T>,
  validate?: (value: T) => string[] | Promise<string[]>,
): Promise<CheckResult<T>> {
  const ex = extractJson(text);
  if (!ex.ok) return { ok: false, errors: [ex.error] };
  // zod recurses on the call stack: a reply nested thousands of levels deep would throw RangeError
  if (jsonDepth(ex.value, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) return { ok: false, errors: [`the JSON is nested too deeply (more than ${MAX_JSON_DEPTH} levels)`] };
  const parsed = schema.safeParse(ex.value);
  if (!parsed.success) return { ok: false, errors: formatZodError(parsed.error) };
  const extra = validate ? await validate(parsed.data) : [];
  if (extra.length) return { ok: false, errors: extra };
  return { ok: true, value: parsed.data };
}

/**
 * Ask `provider` for JSON matching `schema`. Transport errors (auth, rate limit after the
 * provider's own retries, refusal…) propagate unchanged; unusable output triggers up to
 * `retries` repair turns, then StructuredOutputError.
 */
export async function completeStructured<T>(
  provider: LLMProvider,
  req: CompletionRequest,
  schema: z.ZodType<T>,
  opts: StructuredOptions<T> = {},
): Promise<StructuredResult<T>> {
  const retries = Math.max(0, opts.retries ?? 2);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let messages: ChatMessage[] = req.messages;
  let lastErrors: string[] = [];
  let lastText = '';
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let text = '';
    let model = provider.model;
    let truncated = false;
    let errors: string[] = [];
    try {
      const res = await provider.complete({ ...req, messages });
      usage.inputTokens += res.usage?.inputTokens ?? 0;
      usage.outputTokens += res.usage?.outputTokens ?? 0;
      text = res.text;
      model = res.model;
      truncated = res.stopReason === 'max_tokens' || res.stopReason === 'length';
    } catch (e) {
      // an empty / malformed provider envelope is a model-output problem worth one more try
      if (!(e instanceof LLMInvalidResponseError)) throw e;
      errors = [e.message];
    }
    if (!errors.length) {
      const checked = await checkStructuredText(text, schema, opts.validate);
      if (checked.ok) {
        opts.onAttempt?.({ attempt, ok: true, errors: [] });
        return { value: checked.value, attempts: attempt, usage, text, model };
      }
      errors = checked.errors;
    }
    if (truncated && !errors.some((e) => /cut off/.test(e))) errors.push('The reply hit the output token limit and was cut off.');
    opts.onAttempt?.({ attempt, ok: false, errors });
    lastErrors = errors;
    lastText = text;
    const echo = text.length > (opts.maxEchoChars ?? 120_000) ? text.slice(0, opts.maxEchoChars ?? 120_000) : text;
    messages = [
      ...req.messages,
      ...(echo.trim() ? [{ role: 'assistant' as const, content: echo }] : []),
      { role: 'user' as const, content: repairMessage(errors, truncated, opts.maxErrorsInRepair) },
    ];
  }
  throw new StructuredOutputError(
    `${req.purpose}: no valid output after ${retries + 1} attempts: ${lastErrors.slice(0, 3).join('; ')}`,
    { errors: lastErrors, lastText, attempts: retries + 1, usage },
    { provider: provider.id },
  );
}
