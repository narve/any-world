# 'Undersøk' means both look (x) and search (f)

Severity: minor · Owner: i18n · Status: fixed

## Evidence
nb.ts: help.look 'Se deg rundt (undersøk)', help.search 'Undersøk her', ctx.search 'Undersøk', help.mouse.hover 'Undersøk · …', onboard.verb.search 'Undersøk: …'. The help overlay (nb-r1-troll-11-help.png) listed both x and f as "undersøk".

## Fix
Search = "Let": ctx.search 'Let', help.search 'Let etter skjulte ting her', onboard.verb.search 'Let: …', engine.invalid.searching_is_not_possible_here 'Her kan du ikke lete'. Look = 'Se deg rundt'; hover 'Se på · viser ruten et klikk tar'.

## Regression test
tests/i18n/m5-wording.test.ts (no "undersøk" in any look/search key).
