/**
 * The pass a server open to everyone asks for on AI calls (server/llm-guard.ts): fetch a
 * proof-of-work challenge, find n with sha256(salt + n) = challenge, trade the answer for a pass and
 * keep it until shortly before it expires. Shared by browser and Node (WebCrypto + fetch).
 */
import { LLMConfigError, LLMInvalidResponseError } from './errors';
import type { BackendAuth } from './transport';
import type { HttpOptions } from './http';

/** the header that carries the pass (server/llm-guard.ts PASS_HEADER) */
export const PASS_HEADER = 'x-anyworld-pass';

interface Challenge {
  algorithm: string;
  challenge: string;
  salt: string;
  maxNumber: number;
  signature: string;
}

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** the n ≤ maxNumber with sha256(salt + n) = challenge, or null; yields now and then so the page stays responsive */
export async function solveChallenge(c: Pick<Challenge, 'challenge' | 'salt' | 'maxNumber'>, signal?: AbortSignal): Promise<number | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new LLMConfigError('This browser cannot compute SHA-256 (WebCrypto), needed for the server pass');
  const enc = new TextEncoder();
  for (let n = 0; n <= c.maxNumber; n++) {
    if (n % 2000 === 0) {
      if (signal?.aborted) return null;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (hex(await subtle.digest('SHA-256', enc.encode(c.salt + n))) === c.challenge) return n;
  }
  return null;
}

export function createPassAuth(backendUrl = '', opts: { fetch?: HttpOptions['fetch'] } = {}): BackendAuth {
  const base = backendUrl.replace(/\/+$/, '');
  let pass: { value: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const fetchPass = async (signal?: AbortSignal): Promise<string> => {
    const f = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as HttpOptions['fetch']);
    if (!f) throw new LLMConfigError('No fetch implementation available');
    const cr = await f(`${base}/api/pass/challenge`, { signal });
    if (!cr.ok) throw new LLMInvalidResponseError(`GET /api/pass/challenge failed with HTTP ${cr.status}`);
    const c = (await cr.json()) as Challenge;
    const number = await solveChallenge(c, signal);
    if (number === null) throw new LLMInvalidResponseError('The server pass challenge had no answer');
    const pr = await f(`${base}/api/pass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ salt: c.salt, number, challenge: c.challenge, signature: c.signature }),
      signal,
    });
    if (!pr.ok) throw new LLMInvalidResponseError(`POST /api/pass failed with HTTP ${pr.status}`);
    const j = (await pr.json()) as { pass?: string; expiresAt?: number };
    if (typeof j.pass !== 'string' || typeof j.expiresAt !== 'number') throw new LLMInvalidResponseError('Malformed pass from the server');
    pass = { value: j.pass, expiresAt: j.expiresAt };
    return j.pass;
  };

  return {
    async headers(signal) {
      // a minute of slack, so a pass does not expire on its way
      if (pass && pass.expiresAt - Date.now() > 60_000) return { [PASS_HEADER]: pass.value };
      pending ??= fetchPass(signal).finally(() => {
        pending = null;
      });
      return { [PASS_HEADER]: await pending };
    },
    invalidate() {
      pass = null;
    },
  };
}
