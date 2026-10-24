# Loss screen gave no cause beyond the defeat word

- Severity: minor
- Area: engine (src/engine/combat.ts dealDamage/killPlayer/lossReason, turn.ts checkEnd, types.ts GameState.lastHarm)
- Status: fixed

## Evidence
playtest-r1-ui-western-death.png: the subtitle was only "put in the dirt". killPlayer named the killer only when the killing blow had a source still in the area. Deaths from statuses, or through checkEnd (hp ≤ 0 after a turn), gave the bare word.

## Fix
dealDamage records `state.lastHarm = {by?: name, damageType, turn}` whenever the player takes damage. `lossReason(ctx, killer?)` builds `"<defeated> by <killer or last source>"` and adds `" (<damage type name>)"` when the world names that damage type, e.g. "put in the dirt by Mesa Rattler (Lead)". killPlayer and checkEnd both use it. A status applied by an actor credits that actor through its sourceId.

## Regression test
tests/engine/difficulty.test.ts "loss reason": killer with a named damage type; the killer has left (last harm is used); a death from a sourceless status ("bested (fire)").
