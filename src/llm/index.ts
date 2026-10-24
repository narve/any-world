/** Public surface of the LLM layer (browser-safe; Node-only helpers live in recordings-node.ts). */
export * from './types';
export * from './errors';
export * from './presets';
export { AnthropicProvider, ANTHROPIC_API_VERSION, ANTHROPIC_DEFAULT_MODEL, type AnthropicProviderOptions, type AnthropicEffort } from './anthropic';
export { OpenAICompatibleProvider, stripThinking, type OpenAICompatibleOptions } from './openai-compatible';
export { MockProvider, parseRecordingsFile, type Recording, type MockProviderOptions, type MockFailureMode } from './mock';
export {
  completeStructured,
  extractJson,
  relaxJson,
  toJsonSchema,
  repairMessage,
  StructuredOutputError,
  type StructuredOptions,
  type StructuredResult,
  type Usage,
} from './structured';
export {
  createProvider,
  createDirectProvider,
  BackendProvider,
  fetchServerPresets,
  type CreateProviderOptions,
  type BackendRequestBody,
  type ServerPresetInfo,
} from './transport';
export { requestHash, stableStringify } from './hash';
export { redact, type HttpOptions, type FetchLike } from './http';
export { sanitizeSchemaForAnthropic, isRecursiveSchema, jsonInstruction, findOpenObjects, supportsAnthropicNativeSchema } from './json-schema';
