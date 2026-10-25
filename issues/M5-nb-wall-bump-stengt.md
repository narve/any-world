# Wall bump shows 'Stengt' (closed)

Severity: minor · Owner: i18n · Status: fixed

## Evidence
Log shows 'Stengt ×2' after walking into walls (nb-r1-troll-06-combat); nb.ts engine.invalid.blocked 'Stengt'.

## Fix
'Sperret'.

## Regression test
tests/i18n/m5-wording.test.ts; tests/i18n/engine-text.test.ts updated.
