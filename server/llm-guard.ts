/**
 * Guards for POST /api/llm when the server's AI is open to everyone (no ANYWORLD_HOST_CODE):
 *
 * - Proof of work (ANYWORLD_LLM_POW=1): GET /api/pass/challenge hands out an ALTCHA-style challenge
 *   (find n ≤ maxNumber with sha256(salt + n) = challenge; HMAC-signed, so the server keeps no state
 *   until it is solved). POST /api/pass with the answer returns a pass, an HMAC-signed expiry the
 *   client sends as X-AnyWorld-Pass on every AI call. Simple bots run no JavaScript and never get
 *   one; a script that does pays about a second of CPU per pass. The key is random per process, so
 *   a restart voids every pass and the client solves a new challenge.
 * - Daily budget (ANYWORLD_LLM_CALLS_PER_DAY, ANYWORLD_LLM_TOKENS_PER_DAY): a cap on AI calls and on
 *   input + output tokens for everyone together per UTC day. Counted in memory, so a restart starts
 *   the day's count again. Calls already running when the cap is reached may overshoot it a little.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** the header that carries the pass */
export const PASS_HEADER = 'x-anyworld-pass';
/** the error code (body `type`) of a call refused because the day's budget is used up */
export const DAILY_BUDGET_CODE = 'daily_budget';

export interface PowOptions {
  /** the largest n a challenge may use; the client tries maxNumber / 2 hashes on average */
  maxNumber?: number;
  /** how long a challenge may be solved, ms; default 10 minutes */
  challengeTtlMs?: number;
  /** how long a pass lasts, ms; default 12 hours */
  passTtlMs?: number;
  now?: () => number;
  /** HMAC key; default random per process */
  key?: Buffer;
}

export interface Challenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  maxNumber: number;
  signature: string;
}

export interface Solution {
  salt: string;
  number: number;
  challenge: string;
  signature: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const sameHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

export class ProofOfWork {
  readonly maxNumber: number;
  private readonly challengeTtl: number;
  private readonly passTtl: number;
  private readonly now: () => number;
  private readonly key: Buffer;
  /** solved challenges until they expire, so one answer buys one pass */
  private readonly used = new Map<string, number>();

  constructor(opts: PowOptions = {}) {
    this.maxNumber = Math.max(1, Math.floor(opts.maxNumber ?? 100_000));
    this.challengeTtl = opts.challengeTtlMs ?? 10 * 60_000;
    this.passTtl = opts.passTtlMs ?? 12 * 3600_000;
    this.now = opts.now ?? (() => Date.now());
    this.key = opts.key ?? randomBytes(32);
  }

  private sign(s: string): string {
    return createHmac('sha256', this.key).update(s).digest('hex');
  }

  challenge(): Challenge {
    const salt = `${randomBytes(12).toString('hex')}?expires=${this.now() + this.challengeTtl}`;
    const challenge = sha256(salt + randomInt(0, this.maxNumber + 1));
    return { algorithm: 'SHA-256', challenge, salt, maxNumber: this.maxNumber, signature: this.sign(challenge) };
  }

  /** a pass for a correct, unexpired, unused answer; null otherwise */
  redeem(s: Solution): { pass: string; expiresAt: number } | null {
    const t = this.now();
    const expires = Number(/[?&]expires=(\d+)$/.exec(s.salt)?.[1]);
    if (!Number.isFinite(expires) || expires < t) return null;
    if (!sameHex(this.sign(s.challenge), s.signature)) return null;
    if (!Number.isInteger(s.number) || s.number < 0 || s.number > this.maxNumber) return null;
    if (!sameHex(sha256(s.salt + s.number), s.challenge)) return null;
    for (const [c, exp] of this.used) if (exp < t) this.used.delete(c);
    if (this.used.has(s.challenge)) return null;
    this.used.set(s.challenge, expires);
    const expiresAt = t + this.passTtl;
    const body = `${expiresAt}.${randomBytes(9).toString('base64url')}`;
    return { pass: `${body}.${this.sign(`pass:${body}`)}`, expiresAt };
  }

  /** the pass is one this process signed and it has not expired */
  valid(pass: string | undefined): boolean {
    const m = /^(\d+)\.([\w-]+)\.([0-9a-f]{64})$/.exec(pass ?? '');
    if (!m) return false;
    if (!sameHex(this.sign(`pass:${m[1]}.${m[2]}`), m[3]!)) return false;
    return Number(m[1]) >= this.now();
  }
}

export interface DailyBudgetOptions {
  /** AI calls per UTC day for everyone together; undefined = no cap */
  calls?: number;
  /** input + output tokens per UTC day; undefined = no cap */
  tokens?: number;
  now?: () => number;
}

export class DailyBudget {
  private day = '';
  private calls = 0;
  private tokens = 0;
  private readonly now: () => number;

  constructor(private readonly opts: DailyBudgetOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  get capped(): boolean {
    return this.opts.calls !== undefined || this.opts.tokens !== undefined;
  }

  private roll(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.calls = 0;
      this.tokens = 0;
    }
  }

  /** ms until the next UTC midnight, when the budget starts over */
  msToReset(): number {
    const t = this.now();
    const next = new Date(t);
    next.setUTCHours(24, 0, 0, 0);
    return next.getTime() - t;
  }

  /** counts one call when the day's budget allows it; false = used up */
  take(): boolean {
    this.roll();
    if (this.opts.calls !== undefined && this.calls >= this.opts.calls) return false;
    if (this.opts.tokens !== undefined && this.tokens >= this.opts.tokens) return false;
    this.calls++;
    return true;
  }

  /** adds a finished call's tokens */
  spend(tokens: number): void {
    this.roll();
    this.tokens += Math.max(0, tokens);
  }

  /** "500 calls, 2000000 tokens" for the start-up log */
  describe(): string {
    return `${this.opts.calls ?? 'unlimited'} calls, ${this.opts.tokens ?? 'unlimited'} tokens`;
  }

  usage(): { day: string; calls: number; tokens: number } {
    this.roll();
    return { day: this.day, calls: this.calls, tokens: this.tokens };
  }
}
