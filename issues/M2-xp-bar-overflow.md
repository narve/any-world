# XP bar shows overflow like '175 / 38' while level-ups are pending

- Severity: minor
- Area: client (src/client/view.ts, src/client/ui/components/hud.ts, src/client/ui/viewmodel.ts)
- Status: fixed

## Evidence
playtest-r1-ui-teen-levelup.png: after `grant_xp 200` the player card showed "Lv 2  175 / 38" with the bar full, while two more level-ups were queued (the player ended at level 4).

## Fix
- `xpProgress(world, level, xp, need)` (view.ts): when xp reaches the threshold (the engine holds further level-ups while a perk choice is open), the bar is clamped to `need / need`. It also counts `pendingLevels` by stepping through the next thresholds with the engine's curve (`firstLevelXp * curve^(level-1)`, as in engine/progression.ts).
- `HudView.pendingLevels` is shown as a "+N levels" badge under the XP bar, with a tooltip.

## Regression test
- tests/client/m2-client-fixes.test.ts "xp progress with queued level-ups": plain progress, a clamped bar with 2 queued levels, and a session with 500 xp never shows more xp than the bar holds.
- e2e/client-m2-fixes.spec.ts (teen): after `grant_xp 200` the bar text is ≤ its max and the badge is visible. Screenshot: docs/archive/progress/M2/client-fix-xp-pending.png.
