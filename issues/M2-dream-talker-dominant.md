# Dream is trivial for talk-first play: the talker wins 91-92% by persuading ~17 hostiles neutral per run

- Severity: major
- Area: content (content/worlds/fixture-dream.json), schema (ActorDef), engine (npc.ts doPersuade)
- Status: fixed

## Evidence
From the 100-seed sim, the dream talker won 91% (88% with `--gm`) while the explorer won 58%. Over 40 seeds the talker sent 1317 persuade actions and 281 attacks. With persuade on it got 17.3 "backs down" per run. With `verbs.persuade=false` the same bot won 57%. Its profile has `kite:false`, so the earlier BUILD_LOG / M2-fixtures-too-easy explanation, that it won by kiting the Erasure, was wrong.

## Root cause
Dream hostiles have no `npc` block, so `doPersuade` derives the check from hp: `10 + hp/6 (+2 if hostile)`. For the 5-26 hp shapes that gives DC 12-16. With Harmony 14 (+2) plus level/2, each try succeeds about 50-70% of the time. A failed try only alerts the target. The talker reached the Erasure at full strength, with no fights spent.

Adding `npc` blocks to the mobs (the suggested fix) would have side effects. The actor would become talkable. Its hp would no longer scale with difficulty (actors.ts skips npc actors). It would lose the default-attack fallback in combat.ts. The offline director would also treat it differently.

## Fix
- **Contract, backwards compatible.** `ActorDef.persuadeDifficulty?: int 1..30` sets the persuade check for an actor without an npc block. Without it the engine keeps deriving the check from hp.
- **Engine.** In `src/engine/npc.ts`, the DC is now `npc.persuadeDifficulty ?? def.persuadeDifficulty ?? derived`. The +2 for a hostile target still applies on top.
- **Content (dream).**
  - The mindless shapes (running drip, dissonant moth, grey wash, acute angle) are set to 19. That means 21 against a hostile, so only a high roll or a natural 20 works.
  - Concentric stare, Möbius eel and hungry bloom are set to 17.
  - The perspective warden is set to 18.
  - Talking things down still works against the "thinking" shapes, but it is no longer a free pass for the whole run.

## Result (`npm run sim -- --world content/worlds/fixture-dream.json`)
| bots | before | after |
|---|---|---|
| talker, seeds 1-200 | 92% (60 seeds) | 63% |
| talker `--gm`, seeds 1-100 | 88% | 68% |
| explorer, seeds 1-100 | 58% | 47-58% (same rules; the variation comes from the currency bounties added in M2-currency-never-earned) |

Teen (talker 63%) and western (talker 52%) are unchanged and in band.

## Follow-up (sim owner, not done here)
`verdictFor` looks only at the explorer. It should also flag `too_easy` when any smart bot (for example the talker) wins far above the band, because that bot's strategy is one a player can copy.

## Regression test
`tests/content/m2-currency-persuade.test.ts`, "persuadeDifficulty on actors without an npc block". It covers four things:
- the DC is honoured (DC 30 means natural 20s only);
- the actor is still not talkable;
- every dream rank-and-file hostile has DC ≥ 17, and the mindless shapes have ≥ 19;
- the talker wins at most 10 of 12 seeds.
