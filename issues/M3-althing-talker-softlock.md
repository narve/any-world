# Every Clause Binds: persuading the boss without the area's oath-ring made the run unwinnable

- Severity: major
- Area: content (content/worlds/viking-lawspeaker-althing.json)
- Status: fixed
- Source: BUILD_LOG.md [M3/world-author viking-lawspeaker-althing]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
Sim with the talker bot: after persuading the area boss, a player who had not picked up the family oath-ring
could never leave the area. The first reply was also too easy (explorer 98%): the Law-Knot path won on turn 1
of the finale.

## Fix
Each area's exit needs that area's oath-ring (no route around it), the Law-Knot adds to the counter
"thirds-recited" (win at 3, cooldown 12, noise 12), hostile damage +1 tier, and the Hof satirist became a chaser
instead of a kiter. Sim over 100 seeds on normal: explorer 54%, cautious 56%, talker 80%, 0 crash, 0 stuck.

## Regression tests
`npm run validate-worlds` and `npm run sim` at the M3 gate (0 stuck on all worlds); tests/content/prompts.test.ts validates every recorded world.
