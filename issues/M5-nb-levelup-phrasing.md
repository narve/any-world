# Level-up and pending-level phrasing is awkward

Severity: minor · Owner: i18n · Status: fixed

## Evidence
'Få: Muntlig klage' (perk.gain); '2 nivåer til opptjent – de kommer ett om gangen etter hvert valg' (hud.pendingTip); 'Nv. 2' (hud.levelAbbr).

## Fix
perk.gain 'Ny evne: {item}'; hud.pendingTip '{n, plural, one {# nytt nivå} other {# nye nivåer}} opptjent – du velger ett om gangen'; hud.levelAbbr 'Niv. {level}'.

## Regression test
tests/i18n/m5-wording.test.ts (both plural branches).
