# Model allowlist open for the "custom" preset with a server API key: any client can run any model on the owner's key

- Severity: major
- Area: server/app.ts allowedModelsFor / providerFor
- Status: fixed

## Evidence
`allowedModelsFor` returned null (any model) when `!p.needsKey && listed.length === 0`. The custom
preset has `needsKey: false` but reads `CUSTOM_LLM_API_KEY`. With CUSTOM_LLM_BASE_URL set to a paid
host, CUSTOM_LLM_API_KEY=sk-owner-paid-key and CUSTOM_LLM_MODEL=cheap-8b, a POST /api/llm with model
'meta-llama/Llama-3.1-405B-Instruct-Turbo' returned 200. The upstream got `Bearer sk-owner-paid-key`
and the requested model, and /api/presets reported `modelsRestricted: false`. Each new model id also
cached a provider in the `providers` Map forever.

## Fix
- `allowedModelsFor` now treats a preset as keyed when it needs a key **or** has one configured:
  `if (!p.needsKey && !keyFor(p) && listed.length === 0) return null`. A keyed custom preset accepts
  only CUSTOM_LLM_MODEL plus `CUSTOM_MODELS` (comma-separated). `LLM_ALLOW_ANY_MODEL=1` still opens all
  presets, and only keyless local presets stay open.
- The `providers` cache is an LRU capped by `AppOptions.maxCachedProviders` (or
  `LLM_MAX_CACHED_PROVIDERS`, default 64). Open presets can no longer grow server memory with
  made-up model ids. `App.cachedProviderCount()` and `startServer().cachedProviderCount()` expose its
  size.
- The server/index.ts header documents both settings.

## Regression tests
tests/server/llm-limits.test.ts "server model allowlist for a keyed custom preset":
- a non-default model on the keyed custom preset gets 400 with no upstream call. The default model
  goes upstream with the owner key, and /api/presets reports `modelsRestricted: true`, models
  ['cheap-8b'];
- CUSTOM_MODELS extends the list, and a keyless custom preset stays open;
- the provider cache stays at `maxCachedProviders` after 10 distinct models on an open preset.
