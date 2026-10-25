# Landscape dialogue sheet cuts off Persuade/Trade/Leave

- Severity: minor (M5 review round 1)
- Area: src/client/styles/ui.css
- Status: fixed

## Evidence
iPhone 15 landscape: the action buttons were half below the screen edge; the player had to scroll the sheet.

## Fix
On phones the dialogue foot is sticky at the bottom of the sheet with padding for the home bar; in landscape the portrait, head, reply and history are smaller (history scrolls at 22vh).

## Regression tests
e2e/m5-client-fixes.spec.ts (Leave fully inside the 393 px tall viewport).
