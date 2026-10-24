/** Per-key token bucket (key = client IP). In-memory; fine for a single small server. */
export interface RateLimitOptions {
  /** sustained requests per minute; default 30 */
  perMinute?: number;
  /** bucket size (burst); default 10 */
  burst?: number;
  /** clock (ms); injectable for tests */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** when not allowed: how long until one token is available */
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly perMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(opts: RateLimitOptions = {}) {
    this.perMs = (opts.perMinute ?? 30) / 60_000;
    this.burst = Math.max(1, opts.burst ?? 10);
    this.now = opts.now ?? (() => Date.now());
  }

  take(key: string): RateLimitResult {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * this.perMs);
    b.at = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const need = 1 - b.tokens;
    return { allowed: false, retryAfterMs: this.perMs > 0 ? Math.ceil(need / this.perMs) : 60_000 };
  }

  /** drop buckets that have refilled completely */
  private prune(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.perMs >= this.burst) this.buckets.delete(k);
    }
  }
}
