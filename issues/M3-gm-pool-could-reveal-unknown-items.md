# The GM item pool showed unknown items under their true nature

- Severity: major
- Area: llm (GM situation / item pool)
- Status: fixed
- Source: BUILD_LOG.md [M3/gate] Runtime/tool fixes; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
The item pool sent to the GM listed unknown consumables with their real effect and gave no instruction to keep
the secret, so a GM line could name what an unidentified potion does; items that both heal and harm were
labelled as healing.

## Fix
Unknown items are marked "secretly …; never reveal", and heal+harm items are labelled "mixed". The balance
rule-impact estimate counts condition-gated triggers at CONDITIONAL_SHARE 0.3 instead of in full.

## Regression tests
tests/llm/m3-gate.test.ts.
