# Node fetch (undici) cut every upstream call at 300 s, filed it as a network error and retried it

- Severity: major
- Area: src/llm/http.ts (attempt/postJson), server/app.ts upstream options
- Status: fixed

## Evidence
Repro (scratchpad t/undici.mts): a local upstream holds back its headers for 330 s; `postJson` with
`timeoutMs 600000, totalTimeoutMs 1200000, maxRetries 1` printed
`error LLMNetworkError network ... fetch failed cause UND_ERR_HEADERS_TIMEOUT after s 602 upstream hits 2`.
Node's built-in fetch (undici) has its own 300 s `headersTimeout` / `bodyTimeout`. It killed each attempt
before our timer (so `timedOut` stayed false), `fail()` turned it into a retryable `LLMNetworkError`, and
`postJson` re-sent the whole generation. With server defaults (600 s, maxRetries 2), a slow non-streaming
world generation was billed up to 3 times, and `LLM_TIMEOUT_MS` never took effect in Node.

## Fix
- `attempt()` walks the error's cause chain (`undiciTimeoutCode()`); `UND_ERR_HEADERS_TIMEOUT` /
  `UND_ERR_BODY_TIMEOUT` (from fetch or from reading the body) becomes an `LLMTimeoutError` with
  `code: LOCAL_TIMEOUT_CODE`, so it follows the `retryOnTimeout` policy (default: not re-sent).
- Root cause: when the built-in global fetch is used in Node, `attempt()` passes `init.dispatcher =
  longCallDispatcher()`: Node's own global dispatcher (found via `Symbol.for('undici.globalDispatcher.1')`,
  so no `undici` dependency, and the proxy/pool setup such as `EnvHttpProxyAgent` is kept) composed with an
  interceptor that sets per-request `headersTimeout: 0, bodyTimeout: 0`. Our AbortController timer
  (`timeoutMs`, i.e. `LLM_TIMEOUT_MS` on the server) is now what bounds a call. Cached per global
  dispatcher (WeakMap), so `setGlobalDispatcher` is respected. Browsers: no symbol, nothing is sent.
- New `HttpOptions.dispatcher` (explicit dispatcher, or `false` for none). An injected `fetch` gets a
  dispatcher only when one is passed explicitly.

## Regression tests
- tests/llm/undici-timeout.test.ts: fake fetch rejecting with `cause.code UND_ERR_HEADERS_TIMEOUT` /
  body stream erroring with `UND_ERR_BODY_TIMEOUT` -> LLMTimeoutError, exactly 1 upstream call; with
  `retryOnTimeout` it is retried. End-to-end with Node's real fetch: a global dispatcher with a 500 ms
  headers timeout (stand-in for 300 s) and an upstream that answers after 2.5 s -> postJson succeeds
  with 1 hit; with `dispatcher: false` it fails as a local timeout with 1 hit despite maxRetries 2.
