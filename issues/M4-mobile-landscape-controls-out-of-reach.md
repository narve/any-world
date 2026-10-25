# Phone landscape: context buttons, log, goal and badges ran off screen or overlapped

- Severity: major
- Area: client UI CSS (phone layout)
- Status: fixed
- Source: BUILD_LOG.md [M4/mobile] e2e/mobile.spec.ts; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
e2e/mobile.spec.ts (iPhone 13/15, Pixel 7, touch only) found: the landscape context column used
`justify-content: flex-end` with overflow, which pushed buttons out of reach; the expanded log (`width:100%`)
overflowed; the goal body ran off the bottom in landscape; the rules badge overlapped the strip; camera and panel
buttons overlapped in landscape; ticker text spans poked past the screen edge.

## Fix
`margin-top: auto` instead of flex-end, the log width fixed, the goal head clamped and its body sized to the
measured room, badge and button positions moved, ticker spans clipped.

## Regression tests
e2e/mobile.spec.ts (elements inside the viewport and not overlapping, tap targets ≥ 44 px, no horizontal scroll, sheets fit).
