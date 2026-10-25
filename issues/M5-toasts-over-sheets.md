# Toasts sit on top of bottom sheets

- Severity: minor (M5 review round 1)
- Area: src/client/ui/ui.ts (data-sheet), src/client/styles/ui.css
- Status: fixed

## Evidence
'No known way there.' covered the first line of a choice prompt on iPhone 15 portrait.

## Fix
The UI root carries data-sheet='1' while a blocking layer, the narration or the onboarding card is up; phone toasts then move to the top safe area. (Toasts are not dropped: they may carry the reason an action failed.)

## Regression tests
e2e/m5-client-fixes.spec.ts (toast above the dialogue sheet).
