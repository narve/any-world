# Final-stretch goal step points at an opaque story flag

- Severity: major (M5 review round 1)
- Area: src/client/guide.ts (unmetLeaves, currentStep, actionableStep)
- Status: fixed

## Evidence
Lowmoor day 3 with the notebook: 'FINAL STRETCH: Make “The farewell speech is given” happen' — both 'any' branches had one unmet leaf and the tie went to the flag.

## Fix
Ties in `unmetLeaves` on 'any' now prefer the branch with fewer opaque leaves (flags, counters). And a flag leaf is resolved into what makes it happen (`actionableStep`): the item whose use (or the tile whose interaction) sets the flag — get it, meet its use condition (recursively: 'Mags must be left speechless'), then 'Use Junie's Speech Notebook'.

## Regression tests
tests/client/goal-final-stretch.test.ts (moved from tests/review/m5), tests/client/m5-client-fixes.test.ts 'final-stretch goal step'.
