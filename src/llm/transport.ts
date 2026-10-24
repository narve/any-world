/**
 * createProvider: one switch for the provider (preset) and one for the transport.
 * - direct:  the provider runs in-process (browser static build, Node tools/tests); the key is the
 *            caller's own (browser: from localStorage).
 * - backend: requests go to the Node server's POST /api/llm; the server holds the keys.
 */
import type { CompletionRequest, CompletionResponse, LLMProvider, ProviderConfig, ProviderPreset } from './types';
import { AnthropicProvider, type AnthropicEffort } from './anthropic';
import { OpenAICompatibleProvider } from './openai-compatible';
import { MockProvider, type MockProviderOptions } from './mock';
import { getPreset } from './presets';
import { LLMConfigError, LLMInvalidResponseError, llmErrorFromJSON } from './errors';
import { DEFAULT_BACKEND_TIMEOUT_MS, postJson, type HttpOptions } from './http';

export interface CreateProviderOptions extends HttpOptions {
  /** backend transport: server origin ('' = same origin, the default in the browser) */
  backendUrl?: string;
  /** backend transport: path of the proxy endpoint; default '/api/llm' */
  backendPath?: string;
  /** options for the "mock" preset */
  mock?: MockProviderOptions;
  /** Anthropic: force/disable the direct-browser-access header (default: detect) */
  browser?: boolean;
  /** Anthropic: output_config.effort */
  effort?: AnthropicEffort;
  /** default max output tokens */
  maxTokens?: number;
}

/** body of POST /api/llm */
export interface BackendRequestBody {
  preset: string;
  model?: string;
  request: Omit<CompletionRequest, 'signal'>;
}

export class BackendProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly preset: string;
  private readonly explicitModel?: string;
  private readonly url: string;
  private readonly http: HttpOptions;

  constructor(preset: string, model: string | undefined, opts: CreateProviderOptions = {}) {
    this.preset = preset;
    this.explicitModel = model || undefined;
    this.model = model || getPreset(preset)?.defaultModel || preset;
    this.id = `backend:${preset}`;
    this.url = `${(opts.backendUrl ?? '').replace(/\/+$/, '')}${opts.backendPath ?? '/api/llm'}`;
    // the server already retries upstream, so by default the client does not retry (no double spending);
    // the wait outlasts the server's own upstream budget so its typed 504/429/... reaches us first
    this.http = { ...opts, maxRetries: opts.maxRetries ?? 0, timeoutMs: opts.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { signal, ...request } = req;
    const body: BackendRequestBody = { preset: this.preset, request };
    if (this.explicitModel) body.model = this.explicitModel;
    let json: unknown;
    try {
      json = (await postJson({ url: this.url, headers: {}, body, provider: this.id, signal }, this.http)).json;
    } catch (e) {
      // server error bodies are {error:{kind,message,retryAfterMs}}; re-type them faithfully
      const status = (e as { status?: number }).status;
      const m = /HTTP \d+: ([\s\S]*)$/.exec((e as Error).message ?? '');
      const kind = (e as { code?: string }).code;
      if (status && kind && ['auth', 'rate_limit', 'server', 'network', 'timeout', 'bad_request', 'invalid_response', 'refusal', 'config'].includes(kind)) {
        throw llmErrorFromJSON(
          { kind, message: m ? m[1] : (e as Error).message, status, retryAfterMs: (e as { retryAfterMs?: number }).retryAfterMs },
          this.id,
        );
      }
      throw e;
    }
    const r = (json as { response?: CompletionResponse }).response;
    if (!r || typeof r.text !== 'string') throw new LLMInvalidResponseError(`${this.id}: malformed server response`, { provider: this.id });
    return { text: r.text, model: r.model ?? this.model, stopReason: r.stopReason, usage: r.usage };
  }
}

/** Build a provider straight from a preset (used by direct transport and by the server). */
export function createDirectProvider(
  preset: ProviderPreset,
  cfg: { apiKey?: string; baseUrl?: string; model?: string },
  opts: CreateProviderOptions = {},
): LLMProvider {
  const baseUrl = cfg.baseUrl || preset.baseUrl;
  const model = cfg.model || preset.defaultModel;
  if (!baseUrl) throw new LLMConfigError(`Preset "${preset.id}" needs a base URL`);
  if (!model) throw new LLMConfigError(`Preset "${preset.id}" needs a model name`);
  if (preset.needsKey && !cfg.apiKey) throw new LLMConfigError(`${preset.label} needs an API key`);
  if (preset.kind === 'anthropic') {
    return new AnthropicProvider({
      ...opts,
      apiKey: cfg.apiKey,
      baseUrl,
      model,
      browser: opts.browser,
      effort: opts.effort,
      maxTokens: opts.maxTokens,
    });
  }
  return new OpenAICompatibleProvider({
    ...opts,
    baseUrl,
    model,
    apiKey: cfg.apiKey,
    label: preset.id,
    structuredOutput: preset.structuredOutput,
    maxTokensParam: preset.maxTokensParam,
    supportsTemperature: preset.supportsTemperature,
    maxTokens: opts.maxTokens,
  });
}

export function createProvider(config: ProviderConfig, opts: CreateProviderOptions = {}): LLMProvider {
  // keep only recent calls by default: a play session's provider lives as long as the page
  if (config.preset === 'mock') return new MockProvider({ model: config.model, maxCalls: 100, ...opts.mock });
  const preset = getPreset(config.preset);
  if (!preset) throw new LLMConfigError(`Unknown provider preset "${config.preset}"`);
  if (config.transport === 'backend') return new BackendProvider(preset.id, config.model, opts);
  return createDirectProvider(preset, config, opts);
}

/** what GET /api/presets returns per preset (never contains keys) */
export interface ServerPresetInfo {
  id: string;
  label: string;
  region: string;
  kind: ProviderPreset['kind'];
  defaultModel: string;
  models?: string[];
  structuredOutput: ProviderPreset['structuredOutput'];
  configured: boolean;
}

/** Ask the backend which presets it can serve. */
export async function fetchServerPresets(backendUrl = '', opts: { fetch?: HttpOptions['fetch']; signal?: AbortSignal } = {}): Promise<ServerPresetInfo[]> {
  const f = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as HttpOptions['fetch']);
  if (!f) throw new LLMConfigError('No fetch implementation available');
  const res = await f(`${backendUrl.replace(/\/+$/, '')}/api/presets`, { signal: opts.signal });
  if (!res.ok) throw new LLMInvalidResponseError(`GET /api/presets failed with HTTP ${res.status}`);
  const json = (await res.json()) as { presets?: ServerPresetInfo[] };
  return Array.isArray(json.presets) ? json.presets : [];
}
