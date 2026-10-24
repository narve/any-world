# sanitizeSchemaForAnthropic turned z.record into a closed empty object

- Severity: minor
- Area: src/llm/json-schema.ts, src/llm/anthropic.ts
- Status: fixed

## Evidence
The walker dropped every `additionalProperties` and set `additionalProperties:false` on every object.
For `AreaPlan.params` (`z.record(z.string(), z.number())`) the output was
`{"type":"object","additionalProperties":false}`, so under native `output_config.format` the model could
only emit `{}`. Current calls were not affected (WorldSpec, AreaPlan, GmResponse and DialogueResponse
are recursive and use prompt-only JSON), but any non-recursive schema with a record would break.

## Fix
Anthropic structured outputs require `additionalProperties: false` on every object, so a record cannot
be expressed natively. Keeping the schema-valued `additionalProperties` would get a 400.
- `findOpenObjects(schema)` lists the JSON-pointer paths of open object nodes: records/catchalls
  (schema-valued additionalProperties), `patternProperties`, and bare objects with no properties.
- `supportsAnthropicNativeSchema(schema)` is true only for non-recursive schemas with no open objects.
  `AnthropicProvider` uses it to choose native format vs prompt-only JSON. The prompt keeps the full
  schema, including the record, and zod validates the result.
- `sanitizeSchemaForAnthropic` now throws on open objects instead of silently closing them.

## Regression tests
- tests/llm/json-schema.test.ts
