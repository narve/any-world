# spawn_terrain in a GM rule was priced at 0 harm even when the terrain hurts

- Severity: major
- Area: engine (src/engine/rules.ts effectHarm / triggerParts)
- Status: fixed

## Evidence
tests/review/m2/round3.test.ts 'spawning harmful terrain under the player every turn'. on_turn spawn_terrain 'spikes' (onStand damage 1) radius 1 got harm 0, so gentle accepted a permanent damage carpet. Fixtures have several damaging onStand terrains (coolant-leak, hull-breach, copper-coil, glare-patch...).

## Fix
effectHarm prices spawn_terrain as max(0, Σ effectHarm(onStand)) × turns stood, plus (1 + radius) for non-walkable terrain that hems the player in. Turns stood = min(duration, 5, 100 / firings per 100 turns, at least 1): a terrain re-spawned every turn costs one onStand per turn, not five. Help from spawned terrain is never credited (it may land anywhere).

## Regression test
tests/engine/gm-rules-harm-r3.test.ts: the spikes repro (harm > 10), every-turn spikes ≈ 100 hp/100t, every-20-turn spikes cost something but less.
