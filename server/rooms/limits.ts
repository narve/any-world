/**
 * Rate and size limits of the room server (MP2 design §2, §9): token buckets per connection (one per
 * message type and one overall, LIMITS.rates) and the per-IP limits, which are injectable
 * (startServer({ rooms: { limits } })) so tests can reach them quickly. Per-IP counts use
 * RateLimiter keyed by clientIpFrom, so behind Caddy TRUST_PROXY=1 is required (every player would
 * share the proxy's address otherwise).
 */
import { LIMITS, type ClientMsgType } from '../../src/net/protocol';

export interface RoomLimits {
  /** WebSocket upgrades per IP per minute */
  upgradesPerMin: number;
  /** open sockets per IP */
  socketsPerIp: number;
  /** open sockets in all */
  socketsTotal: number;
  /** room creations (and world uploads, invalid ones included) per IP per 10 minutes */
  createsPer10Min: number;
  /** GET /api/rooms and /api/rooms/:code per IP per minute */
  listPerMin: number;
  /** an uploaded world whose first area takes longer than this to make is refused */
  firstAreaMs: number;
  /** a socket whose bufferedAmount exceeds this is closed (1009) */
  socketBufferBytes: number;
  /** ws ping interval; two missed pongs terminate the socket */
  pingMs: number;
}

export const DEFAULT_LIMITS: RoomLimits = {
  upgradesPerMin: 20,
  socketsPerIp: 16,
  socketsTotal: 200,
  createsPer10Min: 6,
  listPerMin: 60,
  firstAreaMs: 2000,
  socketBufferBytes: LIMITS.socketBufferBytes,
  pingMs: 15_000,
};

/** the defaults with some values replaced (unknown keys and non-numbers ignored; 0 is allowed) */
export function roomLimits(partial: Partial<RoomLimits> = {}): RoomLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof RoomLimits)[]) {
    const v = partial[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** a token bucket: `perSec` tokens a second, at most `burst` */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly perSec: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.at = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

type RatedType = keyof typeof LIMITS.rates & ClientMsgType;

/**
 * One connection's buckets: every message takes from the overall bucket and from its type's bucket
 * (when the type has one); 200 rate drops within a minute close the socket (`tooManyDrops`).
 */
export class ConnBuckets {
  private readonly overall: TokenBucket;
  private readonly byType = new Map<string, TokenBucket>();
  private dropsWindowAt: number;
  private drops = 0;

  constructor(now: number) {
    this.overall = new TokenBucket(LIMITS.rates.overall.perSec, LIMITS.rates.overall.burst, now);
    this.dropsWindowAt = now;
    for (const [t, r] of Object.entries(LIMITS.rates)) if (t !== 'overall') this.byType.set(t, new TokenBucket(r.perSec, r.burst, now));
  }

  /** true when the message may go on; false: drop it (and count the drop) */
  take(type: ClientMsgType | null, now: number): boolean {
    const typed = type !== null ? this.byType.get(type as RatedType) : undefined;
    if (this.overall.take(now) && (!typed || typed.take(now))) return true;
    if (now - this.dropsWindowAt >= 60_000) {
      this.dropsWindowAt = now;
      this.drops = 0;
    }
    this.drops++;
    return false;
  }

  /** more than LIMITS.rateDropsMax drops within the current minute */
  get tooManyDrops(): boolean {
    return this.drops >= LIMITS.rateDropsMax;
  }
}
