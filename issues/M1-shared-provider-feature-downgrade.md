# One request could turn off native structured output or fallbacks for every user of the server

- Severity: major
- Area: src/llm/anthropic.ts (complete: disabled set), src/llm/openai-compatible.ts (mode downgrade), server/app.ts (providerFor cache)
- Status: fixed

## Evidence
Repro (scratchpad t/feat.mts): client A POSTs /api/llm with a jsonSchema the upstream rejects with 400
`output_config.format.schema: Schema is too complex...`. `AnthropicProvider` matched /output_config|format|schema/,
added `format` to its provider-wide `disabled` set, and answered via prompt-only JSON. Client B's valid
schema then went out without `output_config.format` (`victim body has output_config.format: false`).
The server caches one provider per preset|model for all clients, so one bad schema (or one player)
downgraded everyone until restart. Same for `fallbacks` (any 400 mentioning "beta") and `effort`, and
`OpenAICompatibleProvider` stepped `this.mode` down json_schema -> json_object -> none for good after
one 400 mentioning "schema".

## Fix
- Fallback is per request: `complete()` keeps a local `dropped` set (Anthropic) / local `mode`
  (OpenAI-compatible) and `buildRequest(req, dropped | modeOverride)` leaves the feature out of that one
  retry. Each feature is dropped at most once per call, so the loop terminates.
- Provider-wide memory only for endpoint-level rejections: new `isEndpointFeatureRejection(message,
  paramTokens, opts)` in src/llm/errors.ts. The parameter's own names are stripped, then the message must
  say the parameter is not accepted ("not supported", "Extra inputs are not permitted", "unknown field",
  ...) and must not talk about schema content (schema, complex, depth, $ref, keyword, properties,
  grammar, ...). For `fallbacks`/`effort` (values from provider config, not the request) any non-schema
  rejection counts. `anthropicFeatureRejectedByEndpoint()` wraps it per feature.
- Culprit detection checks `format` before `effort` and `fallbacks`, and the fallbacks pattern uses
  `\bbeta\b`, so a schema error that mentions a property named "beta" no longer turns off fallbacks.
- `AnthropicProvider.disabledFeatures` getter for diagnostics/tests.
- After the fix the repro prints `victim body has output_config.format: true system tail: "s"`.

## Regression tests
- tests/llm/feature-fallback.test.ts (classifier; Anthropic per-call vs remembered; OpenAI per-call vs remembered)
- tests/server/llm-limits.test.ts "server shared provider state": two clients with different schemas;
  the second still sends `output_config.format`.
- tests/llm/anthropic.test.ts: the old test that expected a "schema too complex" error to be remembered
  now expects the format back on the next call.
