# A unique that transforms (e.g. a boss's second phase) can never count as defeated

- Severity: major
- Area: engine (src/engine/actors.ts transformActor, src/engine/combat.ts finishKill)
- Status: fixed

## Evidence
`transformActor` overwrote `a.defId`, and `finishKill` credited `defeated[victim.defId]`, which is the new form. In the repro, a boss with `on_low_hp → transform into golem` under an `actor_defeated boss` win condition left the status at 'playing' after the golem died. The boss's own `on_death` triggers (the test world's `boss-down` flag) never fired. `uniqueSpawnable` also allowed a fresh boss while its golem form was alive.

## Fix
- `ActorInstance.formerDefIds?: string[]` is a new optional, backwards-compatible field. `transformActor` appends the old def id to it. `defChain(a)` (actors.ts) returns every def the instance has been, current last.
- `finishKill` credits `defeated[]` for every def in the chain. It fires the `on_death` triggers of earlier forms that are unique (oldest first, via the new `fireDefTriggers` in triggers.ts), then the current form's triggers.
- `uniqueSpawnable` treats an instance as alive for every def in its chain, so no second copy appears while a later phase lives. A player transform wand used on a unique is covered the same way.

## Regression test
tests/engine/review-r3.test.ts, "transformed uniques": an `actor_defeated` win works through a transform; the original's on_death flag fires; no second boss spawns while the golem phase lives.
