# Kiters, ranged guardians and ambushers stalled the bots in several agent-authored worlds

- Severity: major
- Area: content (several worlds), sim (bots)
- Status: fixed (content); bot navigation hardened again in M5
- Source: BUILD_LOG.md [M3/world-author …] entries and [M3/gate] prompt fixes; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
During M3 world authoring the explorer and cautious bots oscillated beside kiters or waited forever next to
guardians until the runner called the run "stuck": Gullkalven (snap-sladrer, 13% stuck), Neutral Ground
kitchen ("#REF! Error" kiter, 13/100 stuck), Every Clause Binds (Hof satirist), Yams Before the Rain (Panel Leech),
Redundant Upholstery (guardian boss, steamer trunk), Mørketidsis ("Frossen sjømann").

## Fix
Content: the offending actors became chasers, ambushers or wanderers, or got a slower speed, per world (see each
world's BUILD_LOG entry). The world prompt gained a "behaviour pitfalls" section (kiters, guardians, turrets, stun
cooldowns) so generated worlds avoid them. M5: bots track navigation progress per target
(tests/sim/target-progress.test.ts).

## Regression tests
M3 gate sim: 100 seeds × explorer+cautious on all 18 worlds, 0 stuck; tests/sim/target-progress.test.ts; tests/sim/bots.test.ts.
