/**
 * LLM provider contract. Shared by browser ("direct" transport) and Node server ("backend" transport).
 * Must not import DOM- or Node-only modules; use global fetch.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** JSON Schema of the expected output; providers use native structured output when they can */
  jsonSchema?: object;
  /** schema name for providers that need one */
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  /** abort long requests */
  signal?: AbortSignal;
  /** tag for logs / mock lookup ("world", "gm:area_enter", "dialogue") */
  purpose: string;
  /**
   * When the provider has no native structured output, append the JSON Schema to the system prompt.
   * Default: true for schemas up to ~24k chars; larger schemas only get a "reply with JSON only" note
   * (prompts are expected to carry a condensed schema description themselves).
   */
  schemaInPrompt?: boolean;
}

export interface CompletionResponse {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string;
  /** provider-specific stop reason */
  stopReason?: string;
}

export interface LLMProvider {
  readonly id: string;               // "anthropic" | "openai-compatible" | "mock"
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** capabilities of an OpenAI-compatible endpoint */
export interface ProviderPreset {
  id: string;                 // "deepseek"
  label: string;              // "DeepSeek"
  region: string;             // "China", "EU", "US", "Local", "Global"
  kind: 'anthropic' | 'openai-compatible';
  baseUrl: string;
  defaultModel: string;
  models?: string[];
  structuredOutput: 'json_schema' | 'json_object' | 'none';
  /** endpoint allows browser CORS calls */
  cors: boolean;
  needsKey: boolean;
  contextTokens: number;
  notes?: string;
  /** server-side environment variable holding the API key (backend transport) */
  envKey?: string;
  /** server-side environment variable that overrides baseUrl (e.g. OLLAMA_BASE_URL) */
  baseUrlEnv?: string;
  /** OpenAI-compatible: name of the output-token limit field (default "max_tokens") */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** whether the endpoint accepts a `temperature` field (default true; Anthropic: false) */
  supportsTemperature?: boolean;
}

export interface ProviderConfig {
  preset: string;             // preset id or "custom" or "mock"
  baseUrl?: string;
  model?: string;
  apiKey?: string;            // never persisted server-side from the client
  transport: 'direct' | 'backend';
}
