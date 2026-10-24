/**
 * Anthropic Messages API provider over raw fetch (no SDK dependency, so the same code runs in the
 * browser for static deploys and in Node behind the backend proxy).
 *
 * - POST {baseUrl}/v1/messages with x-api-key + anthropic-version.
 * - Browser: adds `anthropic-dangerous-direct-browser-access: true` (the key is the player's own).
 * - Structured output: `output_config.format = {type: "json_schema", schema}` with a sanitised schema;
 *   recursive schemas, or a 400 about the format, fall back to prompt-only JSON. Such a fallback (also for
 *   fallbacks/effort) applies to that one call, unless the endpoint rejects the parameter itself: the
 *   server shares one provider instance between all players.
 * - Refusals (`stop_reason: "refusal"`) throw LLMRefusalError. On models that support it, the
 *   server-side refusal fallback (`fallbacks: "default"`) is requested so a decline is retried on
 *   another model inside the same call.
 * - Sampling parameters (temperature) are not sent: API version 2026-10-21 rejects them.
 */
import type { CompletionRequest, CompletionResponse, LLMProvider } from './types';
import { isEndpointFeatureRejection, LLMBadRequestError, LLMInvalidResponseError, LLMRefusalError } from './errors';
import { postJson, type HttpOptions } from './http';
import { jsonInstruction, sanitizeSchemaForAnthropic, supportsAnthropicNativeSchema } from './json-schema';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_API_VERSION = '2026-10-21';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** models that accept `fallbacks: "default"` on the Claude API */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions extends HttpOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** send the direct-browser-access header; default: true when running in a browser */
  browser?: boolean;
  /** default max_tokens when the request does not set one (non-streaming: keep <= ~16k) */
  maxTokens?: number;
  /** output_config.effort; omitted by default (model default) */
  effort?: AnthropicEffort;
  anthropicVersion?: string;
  /** request server-side refusal fallback; default: on for supported models at the official endpoint */
  refusalFallback?: boolean;
  /** 'native' uses output_config.format when a jsonSchema is given; 'prompt' never does */
  structuredOutput?: 'native' | 'prompt';
  extraHeaders?: Record<string, string>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessage {
  content?: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type Feature = 'fallbacks' | 'format' | 'effort';
/** checked in this order: a schema error that happens to mention "beta" or "effort" is still about the format */
const FEATURE_ORDER: Feature[] = ['format', 'effort', 'fallbacks'];
const FEATURE_PATTERNS: Record<Feature, RegExp> = {
  fallbacks: /fallback|anthropic-beta|\bbeta\b/i,
  format: /output_config|format|schema/i,
  effort: /effort/i,
};
/** the parameter's own names, ignored when deciding whether an error is about this request's schema */
const FEATURE_TOKENS: Record<Feature, string[]> = {
  format: ['output_config.format', 'output_config', 'json_schema'],
  effort: ['output_config.effort', 'output_config'],
  fallbacks: ['anthropic-beta', ANTHROPIC_FALLBACK_BETA],
};

/**
 * May a 400 that named `feature` disable it for every later request on this provider instance
 * (which the server shares between all players)? Only when the endpoint/model rejects the parameter
 * itself; errors about this request's schema ("Schema is too complex") drop it for this call only.
 */
export function anthropicFeatureRejectedByEndpoint(feature: Feature, message: string): boolean {
  return isEndpointFeatureRejection(message, FEATURE_TOKENS[feature], { requireUnsupportedWording: feature === 'format' });
}

export function isBrowser(): boolean {
  return typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { document?: unknown }).document !== 'undefined';
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly opts: AnthropicProviderOptions;
  private readonly baseUrl: string;
  /**
   * features this endpoint/model does not accept at all (see anthropicFeatureRejectedByEndpoint);
   * never sent again by this instance. Request-specific rejections are not stored here.
   */
  private readonly disabled = new Set<Feature>();

  constructor(opts: AnthropicProviderOptions = {}) {
    this.opts = opts;
    this.model = opts.model || ANTHROPIC_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** features currently disabled for every request (diagnostics and tests) */
  get disabledFeatures(): Feature[] {
    return [...this.disabled];
  }

  private off(f: Feature, dropped?: ReadonlySet<Feature>): boolean {
    return this.disabled.has(f) || !!dropped?.has(f);
  }

  private wantsFallback(dropped?: ReadonlySet<Feature>): boolean {
    if (this.off('fallbacks', dropped)) return false;
    if (this.opts.refusalFallback !== undefined) return this.opts.refusalFallback;
    return this.baseUrl === ANTHROPIC_DEFAULT_BASE_URL && FALLBACK_MODELS.has(this.model);
  }

  private nativeFormat(req: CompletionRequest, dropped?: ReadonlySet<Feature>): boolean {
    return (
      !!req.jsonSchema &&
      this.opts.structuredOutput !== 'prompt' &&
      !this.off('format', dropped) &&
      supportsAnthropicNativeSchema(req.jsonSchema!)
    );
  }

  /**
   * Build the HTTP request (exposed for tests and debugging). `dropped` = optional features left out
   * of this one request (after the endpoint rejected them for it).
   */
  buildRequest(
    req: CompletionRequest,
    dropped?: ReadonlySet<Feature>,
  ): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const native = this.nativeFormat(req, dropped);
    let system = req.system;
    if (req.jsonSchema && !native) system += jsonInstruction(req.jsonSchema, req.schemaInPrompt);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 16_000,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (system) body.system = system;
    const outputConfig: Record<string, unknown> = {};
    if (native) outputConfig.format = { type: 'json_schema', schema: sanitizeSchemaForAnthropic(req.jsonSchema!) };
    if (this.opts.effort && !this.off('effort', dropped)) outputConfig.effort = this.opts.effort;
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;

    const headers: Record<string, string> = {
      'anthropic-version': this.opts.anthropicVersion ?? ANTHROPIC_API_VERSION,
      ...(this.opts.extraHeaders ?? {}),
    };
    if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;
    if (this.opts.browser ?? isBrowser()) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    if (this.wantsFallback(dropped)) {
      body.fallbacks = 'default';
      headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
    }
    return { url: `${this.baseUrl}/v1/messages`, headers, body };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // features dropped for this call only; each is dropped at most once, so the loop ends
    const dropped = new Set<Feature>();
    for (;;) {
      const { url, headers, body } = this.buildRequest(req, dropped);
      try {
        const res = await postJson(
          { url, headers, body, provider: this.id, signal: req.signal, secrets: [this.opts.apiKey ?? ''] },
          this.opts,
        );
        return this.parse(res.json);
      } catch (e) {
        // the endpoint (proxy, older version, other model) or this request's schema made an optional
        // feature fail: drop it for this call and retry; remember it only if the endpoint rejects it outright
        if (e instanceof LLMBadRequestError && e.status === 400) {
          const oc = body.output_config as Record<string, unknown> | undefined;
          const sent: Record<Feature, boolean> = { fallbacks: body.fallbacks !== undefined, format: !!oc?.format, effort: !!oc?.effort };
          const culprit = FEATURE_ORDER.find((f) => sent[f] && FEATURE_PATTERNS[f].test(e.message));
          if (culprit) {
            dropped.add(culprit);
            if (anthropicFeatureRejectedByEndpoint(culprit, e.message)) this.disabled.add(culprit);
            continue;
          }
        }
        throw e;
      }
    }
  }

  private parse(json: unknown): CompletionResponse {
    const msg = json as AnthropicMessage;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
      throw new LLMInvalidResponseError('anthropic: response has no content array', { provider: this.id });
    }
    if (msg.stop_reason === 'refusal') {
      const cat = msg.stop_details?.category;
      throw new LLMRefusalError(
        `anthropic: the model declined this request${cat ? ` (${cat})` : ''}${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}`,
        { provider: this.id, code: cat ?? undefined },
      );
    }
    const text = msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!text && msg.stop_reason !== 'max_tokens') {
      throw new LLMInvalidResponseError(`anthropic: response contains no text (stop_reason ${msg.stop_reason ?? 'none'})`, {
        provider: this.id,
      });
    }
    return {
      text,
      model: typeof msg.model === 'string' ? msg.model : this.model,
      stopReason: msg.stop_reason ?? undefined,
      usage: msg.usage
        ? { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
        : undefined,
    };
  }
}
