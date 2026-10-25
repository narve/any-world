# Long 'Talk to <name, title>' pushes Wait off screen on Pixel 7 portrait

- Severity: major (M5 review round 1)
- Area: src/client/guide.ts (shortName in contextActions), src/client/styles/ui.css
- Status: fixed

## Evidence
detective-sugar-hotel seed 13: 'Talk to Hedda Imboden, Head Housekeeper' | Search | 'Wa…' — Wait at x 380..432 in 412 px.

## Fix
Context buttons name people without their title ('Talk to Hedda Imboden'); on phone portrait named buttons are capped at 45vw with an ellipsis, and Wait is sticky at the right end of the scrolling row.

## Regression tests
tests/client/m5-client-fixes.test.ts 'context buttons use short names'; e2e/m5-client-fixes.spec.ts 'Wait stays on screen…' (Pixel 7); e2e/mobile-full-run.spec.ts checks Wait at every area.
