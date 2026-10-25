# "Reaches 5 tiles" did not match the round range check: a visible foe 4 steps away diagonally could not be shot

- Severity: major
- Area: engine (src/engine/fov.ts, combat.ts inAttackRange, ai.ts tryAbility `target_in_range`)
- Status: fixed (engine). Client follow-ups listed below.

## Evidence
Rain Broker: the onboarding says "Your Postal Peacemaker reaches 5 tiles". A Claim Jumper 4 steps away diagonally (-4,-4) was visible. Pressing 1 started the aim on the player, and Enter said "No one hostile in reach there — move the aim onto someone you can see." The jumper (rifle range 6) kept hitting for 5–6 from the same spot (docs/progress/M5/pt-desktop-r3-west-05/06 screenshots). Sabine Lark at (-4,4) behaved the same way. Cause: ranged reach used `fov.withinRadius` (dx²+dy² <= r²+r), so 32 > 30 for range 5, while the range-6 jumper passed (32 <= 42). Repro was the `it.fails` in tests/review/m5/pt-desktop-r3.test.ts.

## Fix
Ranged reach now counts steps. The new `withinReach(a, b, r)` in fov.ts uses Chebyshev distance: a diagonal step counts as one, the same as movement. Ability targeting (`effects.ts`, already `cheb`) used this rule too. `inAttackRange` (every attacker, the player included) and the AI's `target_in_range` ability check use it. Sight and perception stay round (`withinRadius`, which matches `computeFov`).

Symmetry is unchanged. Hostiles still shoot the player from beyond arm's reach only from tiles the player sees (`vision.playerSeesTile`, issues/M1-unseen-diagonal-shooter.md). A reach longer than the sight circle therefore never hits from the dark. The M1 perception-symmetry tests (tests/engine/review-r3.test.ts) still pass.

Not engine-owned, left for the client fixer: change toast `toast.noRangedTarget` to "Out of reach (N)" when the aimed foe is visible but too far, and start the aim on the nearest visible hostile even when it is out of reach. With the metric fixed, a visible foe within N steps is now always legal (`legalActions` offers the attack). So the toast fires only for real out-of-reach cases.

## Regression test
tests/engine/m5-reach-cap.test.ts, "ranged reach counts steps": `withinReach` covers the diagonal cases, and a 5-range bow can attack a rat at (-4,-4) but not one 6 steps away. The review repro was moved out of tests/review/m5/pt-desktop-r3.test.ts.
