# Small catalog wording: dialogue leave 'Gå', weirdness 'Helt på jordet', 'Skade gjort/tatt', tag 'ikke jorda'

Severity: minor · Owner: i18n · Status: fixed

## Evidence
Leave button 'Gå' (nb-r1-troll-12-dialogue); weirdness.unhinged 'Helt på jordet'; end screen 'SKADE GJORT / SKADE TATT'; tag chip 'ikke jorda'; settings.qualityHint says 'Auto …' while the option is 'Automatisk'.

## Fix
dlg.leave / dlg.opt.leave 'Avslutt'; weirdness.unhinged 'Helt sprøtt'; end.stat.harmDealt/harmTaken 'Skade påført' / 'Skade mottatt'; tags.ts non-earth 'utenomjordisk'; qualityHint 'Automatisk velger lav …'.

## Regression test
tests/i18n/m5-wording.test.ts; tests/i18n/engine-text.test.ts updated ('Leave' → 'Avslutt').
