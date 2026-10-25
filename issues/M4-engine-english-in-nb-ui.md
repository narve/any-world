# Engine-made text stayed English in the bokmål UI

- Severity: major
- Area: client i18n wiring (invalid.ts, view.ts, renderer, item card)
- Status: fixed
- Source: BUILD_LOG.md [M4/gate] Wiring; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
In an nb run, refusal reasons, built-in dialogue options ("Goodbye", "Ask what they know"), NPC role titles,
the floating "miss" and item rarity were English: the nb catalog had keys for them but nothing used them.

## Fix
invalid.ts falls back to engineReason(); view.ts uses dialogueOptionLabel() and npcRoleLabel(); the item card
uses item.rarity.*; the renderer's floating "miss" uses missLabel(); the help legend's equipped mark comes from
slot.badge.e.

## Regression tests
tests/i18n/engine-text.test.ts; tests/integration/m4-wiring.test.ts; tests/i18n/e2e/nb-play.spec.ts (English-leak scanner).
