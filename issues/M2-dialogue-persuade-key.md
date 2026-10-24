# Pressing 'p' inside a dialogue does nothing, although the dialogue shows a 'Persuade [p]' button

- Severity: major
- Area: client (src/client/ui/input.ts, src/client/ui/ui.ts, src/client/ui/components/modals.ts)
- Status: fixed

## Evidence
playtest-r1-ui-teen-persuade.png shows the dialogue with a "Persuade p" button. Pressing `p` left the layer as `dialogue` and wrote no persuade log line (playtest-r1-ui.json `persuade-teen`). Clicking the button worked ("Mr. Abernathy-Oyelaran warms to you.", `persuade-teen-click`). In `resolveKey` the dialogue/choice/levelup/trade case only mapped Escape, digits, Enter, arrows and `?`.

## Fix
- `resolveKey` (dialogue layer only, no Shift/Ctrl/Alt/Meta): `p` → `{type:'persuade'}` when `verbs.persuade` is on, and `t` → a new `{type:'trade'}` command.
- `GameUi.command` sends them to `DialoguePanel.persuade()` / `.trade()`. These do exactly what the footer buttons do, and only while that button is shown and enabled (`canPersuade` / `canTrade`, not `pending`).
- The Trade button now shows its key as well (`Trade t`).

## Regression test
- tests/ui/m2-client-fixes.test.ts "conversation keys": `p`/`t` in a dialogue, `p` ignored when persuasion is off, Shift+P and Ctrl+P ignored, and `p`/`t` not taken by the choice, levelup or trade layers.
- e2e/client-m2-fixes.spec.ts (teen): talk with `t`, press `p`; the log grows and does not say "no one nearby". Screenshot: docs/progress/M2/client-fix-persuade-key.png.
