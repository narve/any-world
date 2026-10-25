# Toast template for a full stat breaks gender agreement

Severity: minor · Owner: i18n · Status: fixed

## Evidence
toast.wasted '{full} er allerede full – …' gives 'Blekk er allerede full' for neuter words.

## Fix
'{full}: allerede på maks – bruke {item} likevel? (trykk igjen)'.

## Regression test
tests/i18n/m5-wording.test.ts.
