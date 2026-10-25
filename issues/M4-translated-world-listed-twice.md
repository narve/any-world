# A translated recorded world was listed twice, and the start screen ignored the UI language

- Severity: minor
- Area: client (start screen data: demoWorldsFor, localizePromptLibrary)
- Status: fixed
- Source: BUILD_LOG.md [M4/gate] Start screen in the UI language; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
With the two translated demo worlds, the start screen listed both the English original and the nb copy, and
the inspiration cards and tag chips stayed English in the nb UI.

## Fix
demoWorldsFor() lists a translated world once (the copy in its own language's UI, else the original);
inspiration cards use localizePromptLibrary (one card per translation group); tag chips show tagLabel().

## Regression tests
tests/integration/m4-wiring.test.ts; e2e/m3-gate.spec.ts.
