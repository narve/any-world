# Default enemy attack verb "strikes" was English in any language

- Severity: minor
- Area: engine (src/engine/combat.ts, src/engine/log-keys.ts)
- Status: fixed

## Evidence
`DEFAULT_ACTOR_ATTACK` {name "Strike", verb "strikes"} is the attack of hostile non-NPC actors without
an attack and of recruited allies; its log lines passed verb "strikes" into log.attack.*, so an nb
world read "X strikes Kari (−3 …)". Only fixture-ship has such an actor today, but AI-generated nb
worlds can.

## Fix
Attacks with the built-in attack log with their own keys `log.attack.miss_default`,
`log.attack.hit_default`, `log.attack.crit_default` (no `verb` param; English fallback keeps
"strikes"). The catalogs supply the verb (nb: "går løs på"). World-authored attacks are unchanged.

## Regression tests
tests/engine/m5-robustness.test.ts "default attack": keys end in _default, no verb param, text equals
the engine template, the nb catalog renders without "strikes"; a world-authored attack keeps its verb.
tests/client/log-catalog.test.ts (fixture-ship runs) checks the en catalog renders them like the engine.
