# Goal flag label double-wrapped («…» har skjedd)

- Severity: minor (M5 review round 1)
- Area: src/client/guide.ts (leafText, stepText, ownLabel)
- Status: fixed

## Evidence
nb-russetid: '«Kjøpet av lydanlegget er hevet» har skjedd'.

## Fix
A world label is shown as written; false flags use cond.flagNotLabeled ('Not: {label}'), steps step.flagLabeled / step.avoidFlagLabeled. Bare ids keep the “…” has happened wrapper.

## Regression tests
tests/client/m5-client-fixes.test.ts 'goal labels are shown as written'; tests/client/guide.test.ts updated.
