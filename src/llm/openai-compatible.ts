/**
 * Generic OpenAI-compatible /chat/completions provider (OpenAI, DeepSeek, Mistral, Qwen, Kimi,
 * GLM, OpenRouter, Ollama, LM Studio, custom endpoints).
 *
 * Structured output modes:
 * - json_schema: response_format {type:"json_schema", json_schema:{name, schema, strict:false}}
 * - json_object: response_format {type:"json_object"} + JSON instruction (and schema) in the system prompt
 * - none:        prompt-only JSON instruction
 * If the endpoint answers 400 about response_format, the provider steps down one mode and retries.
 * The step-down is kept for later requests only when the endpoint rejects the mode itself
 * ("response_format of type json_schema is not supported"); an error about this request's schema
 * downgrades this call only (the server shares one provider between all players).
 */
import type { CompletionRequest, CompletionResponse, LLMProvider, ProviderPreset } from './types';
import { isEndpointFeatureRejection, LLMBadRequestError, LLMInvalidResponseError, LLMRefusalError } from './errors';
import { postJson, type HttpOptions } from './http';
import { jsonInstruction } from './json-schema';

export type StructuredMode = ProviderPreset['structuredOutput'];

export interface OpenAICompatibleOptions extends HttpOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  structuredOutput?: StructuredMode;
  /** strict json_schema (all fields required, closed objects); default false */
  strictSchema?: boolean;
  maxTokens?: number;
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  supportsTemperature?: boolean;
  /** label used in errors/logs, e.g. the preset id */
  label?: string;
  extraHeaders?: Record<string, string>;
}

interface ChatChoice {
  message?: { content?: unknown; refusal?: string | null };
  finish_reason?: string | null;
}

interface ChatCompletion {
  choices?: ChatChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DOWNGRADE: Record<StructuredMode, StructuredMode | null> = {
  json_schema: 'json_object',
  json_object: 'none',
  none: null,
};

/** strip <think>…</think> blocks emitted by some reasoning models (Qwen, DeepSeek-R1 via Ollama) */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('');
  }
  return '';
}

function safeSchemaName(name: string | undefined): string {
  const n = (name ?? 'response').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return n || 'response';
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai-compatible';
  readonly model: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly baseUrl: string;
  /** structured mode for new requests; steps down only when the endpoint rejects a mode outright */
  private mode: StructuredMode;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.mode = opts.structuredOutput ?? 'none';
  }

  get structuredMode(): StructuredMode {
    return this.mode;
  }

  /** Build the HTTP request; `modeOverride` = structured mode for this one request (after a step-down). */
  buildRequest(
    req: CompletionRequest,
    modeOverride?: StructuredMode,
  ): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const mode = req.jsonSchema ? (modeOverride ?? this.mode) : 'none';
    let system = req.system;
    if (req.jsonSchema && mode !== 'json_schema') system += jsonInstruction(req.jsonSchema, req.schemaInPrompt);
    const messages: { role: string; content: string }[] = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });
    const body: Record<string, unknown> = { model: this.model, messages };
    body[this.opts.maxTokensParam ?? 'max_tokens'] = req.maxTokens ?? this.opts.maxTokens ?? 8192;
    if (req.temperature !== undefined && this.opts.supportsTemperature !== false) body.temperature = req.temperature;
    if (req.jsonSchema && mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: safeSchemaName(req.schemaName ?? req.purpose), schema: req.jsonSchema, strict: !!this.opts.strictSchema },
      };
    } else if (req.jsonSchema && mode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    const headers: Record<string, string> = { ...(this.opts.extraHeaders ?? {}) };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    return { url: `${this.baseUrl}/chat/completions`, headers, body };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const label = this.opts.label ?? this.id;
    let mode = this.mode;
    for (;;) {
      const { url, headers, body } = this.buildRequest(req, mode);
      try {
        const res = await postJson(
          { url, headers, body, provider: label, signal: req.signal, secrets: [this.opts.apiKey ?? ''] },
          this.opts,
        );
        return this.parse(res.json, label);
      } catch (e) {
        if (
          e instanceof LLMBadRequestError &&
          (e.status === 400 || e.status === 422) &&
          body.response_format !== undefined &&
          /response_format|json_schema|json_object|schema|structured/i.test(e.message)
        ) {
          const next = DOWNGRADE[mode];
          if (next) {
            // keep it for everyone only if the endpoint rejects this mode, and only ever downwards
            if (isEndpointFeatureRejection(e.message, ['response_format', 'json_schema', 'json_object']) && this.mode === mode) {
              this.mode = next;
            }
            mode = next;
            continue;
          }
        }
        throw e;
      }
    }
  }

  private parse(json: unknown, label: string): CompletionResponse {
    const c = json as ChatCompletion;
    const choice = c && Array.isArray(c.choices) ? c.choices[0] : undefined;
    if (!choice || !choice.message) {
      throw new LLMInvalidResponseError(`${label}: response has no choices[0].message`, { provider: label });
    }
    if (choice.message.refusal) {
      throw new LLMRefusalError(`${label}: the model declined: ${choice.message.refusal}`, { provider: label });
    }
    if (choice.finish_reason === 'content_filter') {
      throw new LLMRefusalError(`${label}: response blocked by the provider's content filter`, { provider: label });
    }
    const text = stripThinking(contentToText(choice.message.content));
    if (!text && choice.finish_reason !== 'length') {
      throw new LLMInvalidResponseError(`${label}: empty response (finish_reason ${choice.finish_reason ?? 'none'})`, {
        provider: label,
      });
    }
    return {
      text,
      model: typeof c.model === 'string' && c.model ? c.model : this.model,
      stopReason: choice.finish_reason === 'length' ? 'max_tokens' : (choice.finish_reason ?? undefined),
      usage: c.usage ? { inputTokens: c.usage.prompt_tokens, outputTokens: c.usage.completion_tokens } : undefined,
    };
  }
}
