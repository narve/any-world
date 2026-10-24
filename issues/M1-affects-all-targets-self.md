# An "affects: all" item with nothing in range targets the user (grenade at your own feet); legalActions offers it to bots

- Severity: major
- Area: engine (src/engine/effects.ts autoTarget, src/engine/legal.ts)
- Status: fixed

## Evidence
`autoTarget` fell back to `return user` for 'allies', 'self_only' and 'all'. With no enemy in range, fixture-western 'dynamite' (area range 5, radius 1, affects all) was centred on the player. `legalActions` offered `{type:'use', target: player.pos}`, and `step(use)` without a target damaged the player.

## Fix
`autoTarget(ctx, user, t, effects?)` falls back to the user only for 'allies' and 'self_only'. For 'all' it does so only when the effects are known and harmless. The new exported `isHarmfulEffects` checks for damage, transform, negative resource/stat changes, harmful statuses and hostile summons. Otherwise there is no target, `resolveTargets` returns "no target in range", `useFailure` rejects the use, and `legalActions` no longer offers it. `resolveTargets` takes an optional `effects` argument that `runAction`, `useFailure`, `legalActions` and the AI's `tryAbility` all pass.

## Regression test
tests/engine/review-r3.test.ts, "affects everyone auto-targeting": with nothing in range the blast is not offered and a target-less use is invalid with no damage; with an enemy in range it aims at the enemy; a harmless "everyone" heal still falls back to the user.
