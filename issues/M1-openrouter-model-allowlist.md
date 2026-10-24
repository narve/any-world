# Model allowlist does not apply to OpenRouter: any client can run any model on the server owner's key

- Severity: major
- Area: server/app.ts handleLlm, src/llm/presets.ts (openrouter has no models)
- Status: fixed

## Evidence
With OPENROUTER_API_KEY set, `POST /api/llm {preset:'openrouter', model:'openai/o1-pro', request:{..., maxTokens:32000}}`
returned 200 and the upstream body carried model 'openai/o1-pro'. Cause:
`const openList = !preset.models || preset.models.length === 0;` skipped the allowlist for every preset
without a model list, including the paid, keyed openrouter preset. Each new model id also added a
cached provider to the `providers` Map.

## Fix
`allowedModelsFor(preset)` in server/app.ts:
- `LLM_ALLOW_ANY_MODEL=1` → any model (unchanged).
- Keyed presets (`needsKey`) are always closed: default model (`<ID>_MODEL` or preset default) +
  `preset.models` + operator list `<ID>_MODELS` (comma-separated, e.g. `OPENROUTER_MODELS=a,b`).
- Only keyless presets with no model list (ollama / lmstudio / custom, whose base URL the operator
  set) stay open.
Refusal (400) happens before `providerFor`, so refused ids never grow the provider cache.
`/api/presets` now reports the effective allowed `models` and `modelsRestricted`.

## Regression tests
- tests/server/llm-limits.test.ts "server model allowlist" (non-default openrouter model → 400 with no
  upstream call; OPENROUTER_MODELS / OPENROUTER_MODEL / LLM_ALLOW_ANY_MODEL; local presets stay open;
  keyed presets with lists still enforced)
