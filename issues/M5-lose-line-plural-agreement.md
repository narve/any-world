# Lose-condition line has a subject–verb agreement error with plural HP names

Severity: minor · Owner: i18n · Status: fixed

## Evidence
Deep-sea How-to-play: "HOW YOU LOSE · Your Vitals drops to 0" (en `goal.lose.hp` 'Your {hp} drops to 0'). `goal.lose.resource` 'Your {resource} runs out' has the same problem ("Your Supplies runs out").

## Fix
en: `goal.lose.hp` / `goal.lose.resource` → 'You run out of {hp}' / 'You run out of {resource}', so there is no agreement with the world word. nb mirrors it: 'Du går tom for {hp}' / 'Du går tom for {resource}'.

## Regression test
tests/i18n/m5-wording.test.ts ("lose-condition lines …"); expectation in tests/client/guide.test.ts updated.
