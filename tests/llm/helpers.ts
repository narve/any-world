import type { FetchLike } from '../../src/llm/http';

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: any;
  signal?: AbortSignal | null;
}

export type Reply = Response | ((call: FetchCall) => Response | Promise<Response>);

/** fetch mock that serves `replies` in order (last repeats) and records each call */
export function mockFetch(...replies: Reply[]): FetchLike & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const f = (async (input: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = {
      url: String(input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return typeof r === 'function' ? r(call) : r.clone();
  }) as FetchLike & { calls: FetchCall[] };
  f.calls = calls;
  return f;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function anthropicMessage(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7 },
    ...extra,
  };
}

export function chatCompletion(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    ...extra,
  };
}

/** a fetch that never resolves until aborted */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });

export const fastRetry = { retryBaseMs: 1, maxRetryDelayMs: 50 };
