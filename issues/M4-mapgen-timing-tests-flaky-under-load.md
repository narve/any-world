# tests/mapgen/generators.test.ts timing assertions fail when the sim or Playwright run alongside

- Severity: minor
- Area: tests (mapgen)
- Status: open (known; passes when run alone)
- Source: BUILD_LOG.md [M4/gate] Bundle; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
At the M4 gate the timing assertions in tests/mapgen/generators.test.ts failed only while the sim or Playwright
used the CPU, and passed when run alone.

## Fix
Not changed: the assertion guards against real generator slowdowns. Run vitest without the sim/e2e in parallel
for a gate.

## Regression tests
tests/mapgen/generators.test.ts.
