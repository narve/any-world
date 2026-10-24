# remove_rule bypassed ruleHarmTotal: retiring a helpful GM counterweight was never re-checked

- Severity: major
- Area: engine (src/engine/rules.ts removeRuleRefusal / removeActiveRule, types.ts)
- Status: fixed

## Evidence
tests/review/m2/round2.test.ts, 'the net harm of GM rules never exceeds ruleHarmTotal (normal)'. On normal, with one rule per area, the GM added mend (-5.9), burn_a (+5.9), burn_b (+5.9) and burn_c (+4). Every add was accepted. Then `remove_rule mend` passed, because removeRuleRefusal compared only that rule's 5.9 with ruleHarm 6. The final GM total was 15.8, above ruleHarmTotal 10. Removals had no per-area limit and were never added to any total, so the GM could strip several helpful world rules, one per call.

## Fix
- New `gmRuleHarm(ctx)` adds up the net impact of the GM-added rules in force plus `GameState.gmRetiredHarm`. That field is new and optional: a ledger of the harm from helpful world rules the GM has retired. Retiring a harmful world rule earns no credit. add_rule and remove_rule both check this total.
- `removeRuleRefusal` now:
  - limits retirements to `MAX_GM_RULES_PER_AREA` per area (new `AreaState.gmRulesRemoved`, which resets with each new area);
  - keeps the per-rule check;
  - refuses when the retirement raises the GM total above `ruleHarmTotal`. Retiring a harmful rule is always allowed, because it lowers the total.
- `removeActiveRule` adds a retired helpful world rule's harm to the ledger and counts the retirement for the area.
- `addRuleRefusal` checks the total only when the new rule is harmful. A helpful rule is never refused because of an old total.

## Regression test
tests/engine/gm-rules-harm.test.ts, 'remove_rule respects ruleHarmTotal'. It covers the round-2 repro (the counterweight cannot be retired, while a harmful GM rule can be), the ledger of several small world-rule retirements (two of three are allowed, and the ledger then also blocks a harmful add), retiring a harmful world rule earning no credit, and one retirement per area.
