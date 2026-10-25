# 'snike' used without 'seg' (means jumping the queue)

Severity: minor · Owner: i18n · Status: fixed

## Evidence
log.sneak.off '{player} slutter å snike.', ctx.sneakStop 'Slutt å snike', engine.invalid.sneaking_is_not_possible_here 'Her kan du ikke snike', ctx.sneak 'Snik', hud.sneaking 'Sniker'.

## Fix
'slutter å snike seg', 'Slutt å snike deg', 'Her kan du ikke snike deg', 'Snik deg', 'Sniker seg', help.sneak 'Snik deg (av/på)', onboard.verb.sneak 'Snik deg: …'.

## Regression test
tests/i18n/m5-wording.test.ts: every "snik*" word in nb.ts must be followed by a reflexive pronoun.
