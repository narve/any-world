# Nested 'All of these:' group has no bullet

- Severity: minor (M5 review round 1)
- Area: src/client/ui/components/guide.ts (conditionList)
- Status: fixed

## Evidence
Lowmoor/Trolldirektoratet: 'One of these:' then an unbulleted 'All of these:' and a single bulleted line, which read as part of the group.

## Fix
A group line nested in another (depth > 0) gets the bullet (or ✓) like any other entry of its parent list; only top-level headings stay unbulleted.

## Regression tests
Visual; covered by the onboarding screenshots in e2e/m5-client-fixes.spec.ts.
