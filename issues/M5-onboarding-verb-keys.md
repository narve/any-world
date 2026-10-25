# Onboarding names verbs without keys; tells a gunslinger to walk into enemies

- Severity: minor (M5 review round 1)
- Area: src/client/guide.ts (conflictEntries), src/client/ui/components/guide.ts, src/client/ui/viewmodel.ts (OnboardingView.conflictKeys)
- Status: fixed

## Evidence
How-to-play listed Persuade/Talk/Search/Sneak with no keys; western's Peacemaker has range 5 but the card only said 'walk into someone hostile'.

## Fix
`conflictEntries(world, state)` returns each line with its key (p, t, c, f); the card shows a key cap in keyboard/mouse mode. When the equipped weapon reaches further than one tile a line 'Your {item} reaches N tiles: click or tap someone hostile in sight…' (onboard.conflict.ranged) is added.

## Regression tests
tests/client/m5-client-fixes.test.ts 'onboarding: verbs with their keys…'; e2e/m5-client-fixes.spec.ts (verb key caps visible).
