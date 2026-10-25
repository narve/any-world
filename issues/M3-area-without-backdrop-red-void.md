# Areas with no backdrop rendered as a flat palette-red void

- Severity: minor
- Area: renderer / content
- Status: worked around in content (every recorded area sets a backdrop)
- Source: BUILD_LOG.md [M3/world-author fantasy-retired-mimic]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
Redundant Upholstery: areas without a backdrop showed a flat void in the palette's red, which looked like an
error screen.

## Fix
Every area of the recorded worlds now sets a backdrop, and the world prompt explains backdrop colour semantics
so generated worlds set one too.

## Regression tests
tests/content/prompts.test.ts validates all recorded worlds; e2e/m3-gate.spec.ts starts every world from the start screen.
