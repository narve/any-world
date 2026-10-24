# permadeathMercy was credited as help even after the mercy was spent or when another rule already granted it

- Severity: major
- Area: engine (src/engine/rules.ts estimateRuleImpact / addRuleRefusal / gmRuleHarm / removeRuleRefusal)
- Status: fixed

## Evidence
tests/review/m2/round3.test.ts 'normal refuses a mercy-counterweighted drain once the mercy is spent'. With GameState.mercyUsed = true, normal accepted 'mercy + 1 damage every 7 turns' (net 4.3 vs allowance 6) though it is a pure 14.3 hp/100t drain. Same when a world rule already grants mercy.

## Fix
`estimateRuleImpact(world, rule, { mercyHelps })` (new optional third argument, default true = static view). The GM-side checks are now state-aware:
- addRuleRefusal credits the mercy only if it is unspent and no rule in force grants it.
- gmRuleHarm re-values every GM rule with the current state (liveImpacts): the mercy is credited to one rule at most (a world rule first, then the earliest GM rule) and to none once spent. So a spent counterweight raises the GM total and limits later harmful rules.
- removeRuleRefusal / the gmRetiredHarm ledger value the retired rule's mercy only if no other rule would still grant it and it is unspent; the GM total after retiring a rule re-values the remaining rules without it.

## Regression test
tests/engine/gm-rules-harm-r3.test.ts: the spent-mercy repro; still accepted when unspent; refused when a world rule already grants mercy; retiring a world mercy rule after it is spent is free (no ledger entry).
