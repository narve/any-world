# Damage-over-time log line is a calque: 'Kari Brekkestø tar 3 Skjemavelde.'

Severity: minor · Owner: i18n · Status: fixed

## Evidence
nb.ts log.damage.take_typed '{target|cap} tar {amount} {damageType}.' (nb-r1-x-07-end; the en-western line 'Dolores Aguila tar 1 Heat.' is the nb UI on an English world).

## Fix
'{target|cap} mister {amount} ({damageType}).', matching log.damage.take.

## Regression test
tests/i18n/m5-wording.test.ts.
