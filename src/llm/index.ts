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
export { checkStructuredText, type CheckResult } from './structured';
// M3: prompts, world generation pipeline, GM runtime, recording keys
export * from './recording-keys';
export {
  generateWorld,
  checkWorldReply,
  finaliseWorld,
  balanceWorld,
  balanceFeedbackMessage,
  worldErrors,
  peekTitle,
  isUnplayable,
  WorldGenerationError,
  WORLD_JSON_HINT_SCHEMA,
  type GenerateWorldOptions,
  type GenerateResult,
  type GenerateProgress,
  type GenerateStage,
  type BalanceOptions,
  type WorldGenerationErrorKind,
} from './generate';
export {
  LlmGmDirector,
  LlmDialogue,
  HelpLedger,
  createDemoGm,
  offlineDialogueTurn,
  isHelpfulAction,
  applyHelpCeiling,
  gmActionProblems,
  gmResponseErrors,
  dialogueResponseErrors,
  keepValidActions,
  gmJsonSchema,
  dialogueJsonSchema,
  type LlmGmDirectorOptions,
  type LlmDialogueOptions,
  type DialogueTurnInput,
  type DialogueTurnResult,
  type DemoGmOptions,
} from './gm-runtime';
export { buildWorldPrompt, worldRequest, worldSystemPrompt, worldUserMessage, surpriseDraw, type WorldPromptOptions, type SurpriseDraw } from './prompts/world';
export { buildGmPrompt, gmRequest, gmSystemPrompt, gmUserMessage, HELPFUL_CEILING, HOOK_BRIEF, type GmPromptInput } from './prompts/gm';
export { buildDialoguePrompt, dialogueRequest, type DialoguePromptInput, type DialogueLine } from './prompts/dialogue';
export { languageName, languageInstruction, normaliseLanguage } from './prompts/common';
