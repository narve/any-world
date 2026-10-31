# Floating status label ("Muffled") left behind on the board, e.g. under the player card during level-up

- Severity: minor
- Area: renderer (src/client/render/vfx.ts, src/client/render/index.ts)
- Status: fixed

## Evidence
docs/archive/progress/M2/playtest-r1-fixture-ship-layer-levelup.png shows a stray "Muffled" at about (124,232), far from the player. In docs/archive/progress/M2/playtest-r1-fixture-ship-play-0600.png the same label is correctly above the player's head.

## Root cause
Floating texts (damage numbers, "miss", status names) were world-space sprites placed once, over the actor's tile, when the turn was synced. They are cosmetic tweens that run on after the turn resolves (a status name lasts 1.2 s plus its stagger delay). In fast play, the player keeps walking during that time, and the camera follows the player. So the label stayed on a tile the player had already left, and it drifted across the screen. The level-up modal only made this easy to see: it opened while the label was still playing, and the label ended up next to the HUD.

## Fix
- `VfxLayer.text(..., { follow })`: the text tracks the followed object's x/z every frame. The given position only sets its height. The text is also hidden while the followed object is hidden, so it never shows over an actor that is out of sight.
- `Renderer.sync` passes `follow: v.root` for every actor label (`say`). Labels now ride along with walking, knocked-back or teleported actors, and they cannot be left behind on the board.

## Regression test
- src/client/render/fixes-m2.test.ts, "floating text": a label spawned at (3,4) follows its actor to (9,1) in mid-flight, hides when the actor is hidden and is removed when it ends. Text without `follow` stays put.
