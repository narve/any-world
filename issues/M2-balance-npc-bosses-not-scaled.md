# autoRebalance never scaled hostile NPC bosses (the top killers in 3 of 4 fixtures)

- Severity: major
- Area: sim/balance (src/engine/balance/rebalance.ts)
- Status: fixed

## Evidence
`scaleHostiles` skipped `a.faction !== 'hostile' || a.npc`, so Absalom Vane and Sabine Lark (western), Mags Calloway and Rosalind (teen), The Erasure (dream) and MATRON's Proxy / Warden Ostrova (ship) were never scaled. The "weaken the top killer" step had no effect on them either. Repro: western with hostile hp ×3 and damage ×2.5, tuned 3 rounds × 30 seeds. Company Deputy went 36→21→15→11, but the explorer stayed at 0% wins and deaths moved to Sabine Lark and Absalom Vane, still at ×3. In the too_easy direction, unmodified teen stayed too_easy because Mags was never made tougher.

A second gap: the top-killer lookup compared the death cause with `a.name` exactly. Causes read like "killed by Absalom Vane, the Rain Broker (Storm)", so even with NPCs included the extra cut never landed.

## Fix
- `scaleHostiles` now scales every `faction: 'hostile'` actor, NPC dialogue or not. `persuadeDifficulty` is left alone, so talking a boss down stays as hard as written. Non-hostile actors are never touched.
- New exported `topKiller(world, deathsByCause)` matches each cause to the hostile with the longest name the label starts with, tallies per actor, and returns the top one. rebalance uses it for the ×0.85 cut.
- After the fix (scratchpad/tune2.ts western, hp ×3, damage ×2.5, 30 seeds): rounds go 0% → 0% → 23% → 77%. Absalom Vane goes 156 → 76 hp, Sabine Lark 78 → 39. tuneWorld returns the 23% world (the closest to the 25–60% band).

## Regression test
tests/balance/m2-fixes.test.ts, "rebalance scales hostile NPC bosses":
- too_hard weakens Absalom/Sabine and keeps their persuade DC. Non-hostiles are unchanged.
- too_easy makes Mags and Rosalind tougher.
- topKiller resolves a decorated cause, and the ×0.85 cut lands.
- tuneWorld on western with NPC-boss damage ×3 raises the win rate and lowers Absalom's hp.
