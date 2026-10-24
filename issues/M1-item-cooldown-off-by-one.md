# Item cooldowns end one turn early, and consumed stacks ignore them

- Severity: minor
- Area: engine (src/engine/inventory.ts doUse)
- Status: fixed

## Evidence
Repros: tests/review/engine-round2.test.ts (stack of consumed items with cooldown 5 could be used twice in a row) and tests/review/engine-round3.test.ts (cooldown 1 never blocked anything). The cooldown was set on use and the round tick of the same step took one off. A consumed item was never given a cooldown, so the rest of its stack was usable at once.

## Fix
`doUse` now sets `cooldown = def.cooldown + 1` (so "cooldown N" blocks the next N turns), and for a consumed item the cooldown goes on what is left of the stack. tests/engine/inventory.test.ts was updated to these semantics.
