# Server upstream calls timed out after 120 s and each timeout was retried twice

- Severity: major
- Area: server/index.ts, server/app.ts (providerFor), src/llm/http.ts, src/llm/transport.ts
- Status: fixed

## Evidence
`main()` started the server without `upstream`, and no env var fed `HttpOptions.timeoutMs`, so
upstream calls used `DEFAULT_TIMEOUT_MS = 120_000`. A long non-streaming world-generation call
(maxTokens 32000, thinking always on) can exceed that; `LLMTimeoutError` is retryable, so `postJson`
re-sent the full request up to 2 more times (3 billed generations, results discarded). Repro
(scratchpad s4.mts): `LLMTimeoutError ... upstream calls: 3`. The client's 300 s backend timeout was
either never reached (server gave up at 120 s) or overrun by the retries.

## Fix
- `src/llm/http.ts`:
  - `DEFAULT_TIMEOUT_MS` is now 600 s (in line with the official SDKs).
  - A timeout raised by our own per-attempt timer carries `code: 'local_timeout'` (`isLocalTimeout()`),
    and `postJson` no longer re-sends it unless `retryOnTimeout: true`. The upstream is usually still
    generating (and billing) a request we abandoned. An upstream HTTP 408 is still retried.
  - New `totalTimeoutMs`: an overall budget across attempts and backoff. Attempts are clamped to
    fit it, and no retry starts whose backoff would overrun it.
  - Exported `DEFAULT_SERVER_TOTAL_TIMEOUT_MS` (600 s) and `DEFAULT_BACKEND_TIMEOUT_MS` (660 s).
- `server/app.ts`: `upstreamOptions(env, opts.upstream)` reads `LLM_TIMEOUT_MS` (default 600000),
  `LLM_TOTAL_TIMEOUT_MS` (default = LLM_TIMEOUT_MS) and `LLM_MAX_RETRIES` (default 2). Explicit
  `opts.upstream` wins. GET /api/presets reports `upstreamTimeoutMs` so clients can size their wait.
- `src/llm/transport.ts`: the BackendProvider's default wait is `DEFAULT_BACKEND_TIMEOUT_MS`
  (server budget + 60 s), so the server's typed 504 arrives before the client gives up.
- Same repro after the fix: `upstream calls: 1`.

Follow-up (not done here): stream Anthropic responses so long generations do not depend on a
wall-clock timeout at all.

## Regression tests
- tests/llm/http.test.ts "http helper timeouts"
- tests/server/llm-limits.test.ts "server upstream timeouts"
