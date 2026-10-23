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
}

export interface ProviderConfig {
  preset: string;             // preset id or "custom" or "mock"
  baseUrl?: string;
  model?: string;
  apiKey?: string;            // never persisted server-side from the client
  transport: 'direct' | 'backend';
}
