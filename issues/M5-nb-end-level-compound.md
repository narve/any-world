# End screen stat '{xp}-nivå' gives wrong compounds

Severity: minor · Owner: i18n · Status: fixed

## Evidence
'ANSIENNITET-NIVÅ', 'RYKTE-NIVÅ' (nb-r1-x-08-end-*.png); nb.ts end.stat.level '{xp}-nivå'.

## Fix
'Nivå ({xp})'. It keeps the English param set (the nb catalog check requires identical params) and never builds a compound.

## Regression test
tests/i18n/m5-wording.test.ts.
