# With TRUST_PROXY=1, any client can skip the rate limit via its own X-Forwarded-For

- **Severity:** major
- **Area:** server/app.ts (clientIp)
- **Status:** fixed

## Evidence
`clientIp()` took the FIRST X-Forwarded-For entry. Standard reverse proxies (nginx
`$proxy_add_x_forwarded_for`, Caddy, most load balancers) append the real peer address to whatever the
client sent, so the first entry is attacker-chosen. With `TRUST_PROXY=1 LLM_RATE_BURST=2
LLM_RATE_PER_MIN=1`, six requests with `x-forwarded-for: 10.9.9.<i>, 203.0.113.7` never got a 429; each
fake IP got a fresh bucket (and filled the bucket map), so the owner's paid key could be used without limit.

## Fix
- `TRUST_PROXY` is now a hop count (`parseTrustProxy`): `1`/`true` = one trusted proxy, an integer N = N
  hops, unset/`0`/`false` = header ignored. `AppOptions.trustProxy` accepts `boolean | number`
  (backwards compatible).
- `clientIpFrom(xff, remoteAddress, hops)` uses the hops-th entry from the RIGHT (the one the trusted
  proxy appended), joins repeated headers, falls back to the left-most available entry if the header is
  shorter than the hop count, and to the socket peer if the chosen entry is not a valid IP.
- Documented in `server/app.ts` and `server/index.ts` that the left-most entry is client-controlled.
- Since the key can no longer be chosen by the client, the bucket map can no longer be flooded with fake
  IPs through the header.

## Regression test
`tests/server/hardening.test.ts`: a spoofed left-most entry is still rate-limited (`[_, _, 429, 429, 429, 429]`),
distinct proxy-appended clients keep separate buckets, plus unit tests for `parseTrustProxy` / `clientIpFrom`.
