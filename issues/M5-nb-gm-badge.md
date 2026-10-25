# GM rule source badge shows English 'GM'

Severity: minor · Owner: i18n · Status: fixed

## Evidence
nb-r1-x-02-rules-gm.png: badge 'GM' next to 'VERDEN'; nb.ts rules.srcGm 'GM'.

## Fix
rules.srcGm 'Spillmester' (the tooltip already says "spillmesteren"). English stays 'GM'.

## Regression test
tests/i18n/m5-wording.test.ts.
