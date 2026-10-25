# English world with nb UI gives mixed-language log and goal lines

- Severity: minor (M5 review round 1)
- Area: src/client/guide.ts (inWorldLanguage), src/client/view.ts (worldLanguageLog), src/client/session.ts
- Status: fixed

## Evidence
'Mesa Rattler er put in the dirt.', 'Konflikt heter «Draw on» her…'.

## Fix
When the world's language differs from the UI language and has a catalog, engine log lines are rendered in the world's language (and lose their key), and the goal tracker's and onboarding card's plain-word lines are built in the world's language. UI chrome (headings, buttons) stays in the UI language.

## Regression tests
tests/client/m5-client-fixes.test.ts 'a world in another language than the UI'.
