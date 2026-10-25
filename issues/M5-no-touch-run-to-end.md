# DoD #12: no touch-only run is played to an end screen on a phone

- Severity: major (M5 review round 1)
- Area: e2e/mobile-full-run.spec.ts
- Status: fixed

## Evidence
e2e/mobile.spec.ts plays 260 bot decisions and never requires the end layer.

## Fix
New e2e/mobile-full-run.spec.ts: iPhone 15 and Pixel 7, portrait and landscape, play by touch only (explorer bot decides, every action is a tap) until the end layer; worlds/seeds the explorer wins in the engine sim (fixture-dream 1/9/2, fixture-western 5, nb UI on Pixel portrait). Layout checked at every area change (incl. Wait on screen) and the end screen must fit.

## Regression tests
e2e/mobile-full-run.spec.ts — 4/4 passed (7.4 min, 4 workers): every case reached the end screen by touch only. Results this run (fixture-western, seeds 9/12/5/8): all four ended in a loss (iPhone 15 portrait at turn 619 in area 4/4, Pixel 7 landscape at turn 655 in area 4/4, Pixel 7 portrait (nb UI) at turn 332 in area 2, iPhone 15 landscape at turn 143 in area 2). The live offline GM adds events that the engine sim does not, so the explorer's sim wins do not carry over; a won touch run is not yet guaranteed.

## Found on the way
- Aiming on touch had no way out: tapping the aiming slot again confirms the cursor, and there is no Esc. The aim/look banner now carries a Cancel button on touch (src/client/ui/ui.ts, 44 px).
- Backpack menu buttons carry `data-entry` (equip/use/drop…) so touch automation and tests can pick an action without the label text.
