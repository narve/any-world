# Enemies shoot from diagonal tiles the player can never see (enemies perceive in a square, player sees in a circle)

- Severity: major
- Area: engine (src/engine/fov.ts, vision.ts, combat.ts inAttackRange, ai.ts canPerceive/tryAbility)
- Status: fixed

## Evidence
Western seed 11, area 1 (darkness 0.8 cuts the player's sight from 9 to 7). A Claim Jumper (range 6) fired from (32,25) at the player on (38,19), 6 tiles away diagonally, for 8 turns in a row. The player's FOV (`computeFov`, Euclidean `dx²+dy² <= r²+r`) never contained that tile, while the AI's Chebyshev range and Bresenham `los()` did. In the browser the player went from 23 to 9 HP in 4 waits with no shooter on screen. Screenshot: docs/archive/progress/M1/playtest-western-r3s-shot-from-unseen-diagonal.png.

## Fix
Perception is now symmetric, in two layers:
1. One metric. The new `withinRadius(a, b, r)` in fov.ts applies the same rule as `computeFov` (dx²+dy² <= r²+r). `canPerceive`, ranged `inAttackRange` (for every attacker, the player included) and the `target_in_range` ability check use it instead of Chebyshev distance. Melee still reaches all 8 neighbours.
2. A guarantee. `playerSeesTile(ctx, pos)` (vision.ts) computes a fresh FOV from the player's current position. This keeps it correct mid-round, after pushes or new smoke. A non-player attacker may hit the player from beyond arm's reach only when it stands on such a tile. The rule covers weapon attacks (`inAttackRange`) and offensive hostile abilities that would affect the player (`tryAbility`). The second layer also covers the case the metric alone cannot: a player whose sight (darkness, blindness) is shorter than the enemy's range. An unseen shooter closes in until it is visible.

## Regression test
tests/engine/review-r3.test.ts, "perception symmetry": the 6x6 diagonal shooter with sight 7 never fires; a shooter in range but beyond a short sight holds fire; and a property test over 12 seeds with random walls, shooters, archers and fire-bolt abilities checks that every non-adjacent hit on the player comes from a tile with `seen === 2`. The test is non-vacuous: it fails with the gate removed. tests/engine/combat.test.ts "chasers close in and attack" now places the rat inside its sight circle rather than in a square corner.
