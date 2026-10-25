# Goal tracker crashes on a flag/counter id 'constructor'

- Severity: minor (M5 review round 1)
- Area: src/client/guide.ts (ownLabel, own/counterOf/defeatedOf)
- Status: fixed

## Evidence
stateLabel(world, 'constructor') threw 'l.trim is not a function' (Object.prototype.constructor).

## Fix
Own-key, type-checked reads for goal labels, flags, counters and defeated counts in the goal tracker.

## Regression tests
tests/client/untrusted-world-ids.test.ts (moved from tests/review/m5), tests/client/m5-client-fixes.test.ts 'untrusted ids'.
