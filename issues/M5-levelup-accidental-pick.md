# A number key or Enter during combat instantly picks a perk when the level-up card opens

- Severity: major (M5 review round 3, desktop playtest)
- Area: src/client/ui/components/modals.ts (LevelUpModal, ChoiceModal, Modal), src/client/ui/key-arm.ts
- Status: fixed

## Evidence
Rain Broker, turn 137: firing with '1' then Enter; the kill shot raised the level and the next '1' chose perk 1 before the card could be read. `LevelUpModal.option(i)` called `choose()` at once and the first perk button had `data-autofocus`, so Enter also clicked it. `ChoiceModal` (GM offers) behaved the same.

## Fix
- `KeyArm` (pure, clock injectable): a 500 ms delay (`MODAL_ARM_MS`) that restarts whenever the modal opens or shows a different choice (a second queued level-up).
- `Modal` takes `guardKeys`: the card itself takes the focus (tabindex -1, no outline) instead of the first option, so Enter clicks nothing; `keysArmed()` and `guardClick()` (ignores keyboard-made clicks, `detail === 0`, while not armed).
- `LevelUpModal` and `ChoiceModal` use it: digit keys are ignored until armed; the perk / option buttons have no autofocus. Mouse clicks and taps act at once; arrow keys still move the focus onto an option, and Enter on it works once armed.

## Regression tests
tests/ui/key-arm.test.ts, e2e/m5-client-fixes-r3.spec.ts (keys at open ignored, digit after 650 ms picks, mouse click picks at once).
