/**
 * Error classes for the LLM layer. Every provider maps failures onto these so callers
 * (generation pipeline, GM runtime, UI) can decide: retry, ask for a key, fall back, or give up.
 * Shared by browser and Node; no platform imports.
 */

export type LLMErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'bad_request'
  | 'invalid_response'
  | 'refusal'
  | 'config'
  | 'structured';

export interface LLMErrorInit {
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
  /** raw upstream error type, e.g. "overloaded_error" */
  code?: string;
}

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly provider?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(kind: LLMErrorKind, message: string, init: LLMErrorInit = {}) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'LLMError';
    this.kind = kind;
    this.provider = init.provider;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.code = init.code;
  }

  /** transient failures worth retrying after a pause */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }

  toJSON(): { kind: LLMErrorKind; message: string; status?: number; retryAfterMs?: number; code?: string } {
    return { kind: this.kind, message: this.message, status: this.status, retryAfterMs: this.retryAfterMs, code: this.code };
  }
}

/** 401/403: missing or wrong key, or no access to the model */
export class LLMAuthError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('auth', message, init);
    this.name = 'LLMAuthError';
  }
}

/** 429: slow down; retryAfterMs from the retry-after header when present */
export class LLMRateLimitError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('rate_limit', message, init);
    this.name = 'LLMRateLimitError';
  }
}

/** 5xx / 529 overloaded */
export class LLMServerError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('server', message, init);
    this.name = 'LLMServerError';
  }
}

/** fetch itself failed: DNS, refused connection, CORS block in the browser */
export class LLMNetworkError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('network', message, init);
    this.name = 'LLMNetworkError';
  }
}

/** our own timeout fired */
export class LLMTimeoutError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('timeout', message, init);
    this.name = 'LLMTimeoutError';
  }
}

/** the caller's AbortSignal fired; never retried */
export class LLMAbortedError extends LLMError {
  constructor(message = 'Request aborted', init: LLMErrorInit = {}) {
    super('aborted', message, init);
    this.name = 'LLMAbortedError';
  }
}

/** 400/404/413/422: the request itself is wrong (unknown model, unsupported parameter…) */
export class LLMBadRequestError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('bad_request', message, init);
    this.name = 'LLMBadRequestError';
  }
}

/** 2xx but the body is not what the API promises (non-JSON, missing fields, empty output) */
export class LLMInvalidResponseError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('invalid_response', message, init);
    this.name = 'LLMInvalidResponseError';
  }
}

/** the model declined (Anthropic stop_reason "refusal", OpenAI finish_reason "content_filter") */
export class LLMRefusalError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('refusal', message, init);
    this.name = 'LLMRefusalError';
  }
}

/** misconfiguration on our side: unknown preset, missing key or base URL */
export class LLMConfigError extends LLMError {
  constructor(message: string, init: LLMErrorInit = {}) {
    super('config', message, init);
    this.name = 'LLMConfigError';
  }
}

export function isLLMError(e: unknown): e is LLMError {
  return e instanceof LLMError;
}

/** true for transient failures that a later attempt may fix */
export function isRetryable(e: unknown): boolean {
  return e instanceof LLMError && e.retryable;
}

/** Rebuild a typed error from its JSON form (backend transport). */
export function llmErrorFromJSON(
  json: { kind?: string; message?: string; status?: number; retryAfterMs?: number; code?: string },
  provider?: string,
): LLMError {
  const message = typeof json.message === 'string' ? json.message : 'LLM request failed';
  const init: LLMErrorInit = { provider, status: json.status, retryAfterMs: json.retryAfterMs, code: json.code };
  switch (json.kind) {
    case 'auth': return new LLMAuthError(message, init);
    case 'rate_limit': return new LLMRateLimitError(message, init);
    case 'server': return new LLMServerError(message, init);
    case 'network': return new LLMNetworkError(message, init);
    case 'timeout': return new LLMTimeoutError(message, init);
    case 'aborted': return new LLMAbortedError(message, init);
    case 'bad_request': return new LLMBadRequestError(message, init);
    case 'refusal': return new LLMRefusalError(message, init);
    case 'config': return new LLMConfigError(message, init);
    case 'invalid_response':
    default: return new LLMInvalidResponseError(message, init);
  }
}

/** wording an API uses when a request parameter itself is not accepted by this endpoint/model */
const UNSUPPORTED_PARAM_RE =
  /not supported|unsupported|does not support|doesn't support|not permitted|not allowed|extra inputs|unknown (field|parameter|argument|key|name)|unrecognized|unrecognised|unexpected (field|parameter|argument|key|keyword argument)|not available|no such (field|parameter)/i;
/** wording that points at the content of this request's schema rather than the parameter */
const SCHEMA_CONTENT_RE =
  /schema|complex|too (many|large|deep|long)|exceed|depth|nest|recurs|\$ref|\$defs|definitions|propert|keyword|enum|pattern|grammar|compil/i;

/**
 * Should a 400 that made a provider drop an optional request feature (structured output format,
 * refusal fallbacks, effort) also disable that feature for later requests on the same provider
 * instance? Only when the error says the parameter itself is not accepted by the endpoint or model
 * ("output_config: Extra inputs are not permitted", "'response_format' of type 'json_schema' is not
 * supported"). An error about this request's own schema ("Schema is too complex") is per request:
 * the server shares one provider between all players, and one bad schema must not downgrade them all.
 * `paramTokens` are the parameter's own names (e.g. "output_config.format", "json_schema"); they are
 * removed (case-insensitively) before the message is searched for schema-content wording.
 * `requireUnsupportedWording: false` is for features whose value comes from provider config, not from
 * the request (fallbacks, effort): any rejection of those that is not about a schema is endpoint-level.
 */
export function isEndpointFeatureRejection(
  message: string,
  paramTokens: string[] = [],
  opts: { requireUnsupportedWording?: boolean } = {},
): boolean {
  let m = message;
  for (const t of [...paramTokens].sort((a, b) => b.length - a.length)) {
    if (t) m = m.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  if ((opts.requireUnsupportedWording ?? true) && !UNSUPPORTED_PARAM_RE.test(m)) return false;
  return !SCHEMA_CONTENT_RE.test(m);
}
