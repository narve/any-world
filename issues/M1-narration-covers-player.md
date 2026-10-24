# The narration card stays over the player while you play, and the backpack opens underneath it

- Severity: major
- Area: client (src/client/session.ts, src/client/styles/ui.css)
- Status: fixed

## Evidence
The prologue types at 55 cps, about 10 s for 540 characters. One Enter only finishes the typing, and game keys keep working in the `narration` layer, so the card stayed centred over the player through moves, trades and fights (the layer was still `narration` at turn 4). The backpack panel (z-index 5) drew underneath the card (z-index 6). On entering a new area, the Arrival card hid the board. Screenshots: docs/progress/M1/playtest-western-r3f-04-backpack-open.png, playtest-western-r3f-01-rules.png, playtest-teen-assist-r3-36-area2.png.

## Fix
- Root cause 1: nothing dismissed the narration except an explicit second Enter or click. `GameSession.act` now clears the narration whenever an engine action changes the state, so the player's first move, wait, attack or other action dismisses it. A card opened by that same action (the Arrival card after a transition) stays until the next action. UI-only intents (camera, look) and refused actions do not dismiss it.
- Root cause 2: layout and stacking. The card was placed at `top: 16%` with no height limit and a z-index above the panels. It is now a top banner (`top: 10%`, `max-height: 34%`, scrolls if longer; `6% + 38%` on short screens), so it never reaches the screen centre where the camera keeps the player. Its z-index (2) is below the backpack (5), the modals (20) and the HUD and rules columns (3), so every panel opens on top of it.

## Regression test
tests/client/narration-dismiss.test.ts:
- The first engine action dismisses the prologue. Camera intents and refused actions do not.
- The Arrival card survives the transition and goes on the next action.
- The CSS keeps the card under the backpack, modals and rules column, and above the vertical middle (`top + max-height < 50%`, including the small-screen override).
