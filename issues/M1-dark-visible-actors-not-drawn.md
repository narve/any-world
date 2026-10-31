# In dark areas, enemies the engine counts as visible are not drawn (attacked by an invisible shooter)

- Severity: major
- Area: renderer (src/client/render: cutaway.ts, camera.ts, lighting.ts, actors.ts, index.ts)
- Status: fixed

## Evidence
Ship seed 7, area 1 "The Ductworks" (ambientIntensity 0.2, fog 0.06, playerLight 4). The player was
5 tiles from Warden Ostrova on a clear line; the engine marked her tile visible and she fired at the
player, but `Renderer.samplePixel` at her screen position returned #010408. No model, ring or hp bar
was on screen (docs/archive/progress/M1/playtest-ship-r3d-area1-visible-actors.png).

## Root cause
The engine's line of sight is top-down; the camera's is a tilted perspective. Reproducing the setup
in the dev page showed four separate ways a visible actor could vanish:
1. **Perspective occlusion.** The cut-away only lowered walls in a wedge in front of the player and
   its 8 neighbours. For an actor off the screen centre, the sight line to the camera slants sideways.
   In an east-west duct the wall diagonally in front of the actor (for example (7,2) for an actor at
   (8,1) with the player at (3,1)) hid everything but the top of its head. The screenshot shows only
   her grey hair over the wall block.
2. **Off screen.** At the default zoom (distance 11.5, pitch 52°, fov 38°) only about 4 tiles towards
   the camera are on screen, and the HUD covers some of those. An enemy 5 tiles south was below the
   viewport.
3. **Fog.** Linear fog began 2 units in front of the focus, so actors far up the screen were partly
   fogged, while the engine still showed them as plainly visible.
4. **Darkness.** Dark-clothed models in an area at 0.2 ambient were near black away from lamps and
   the player's light, and the faction ring was fogged.

## Fix
- `occluderTiles()` (cutaway.ts) walks the 3D sight lines from each visible actor (feet, middle, top;
  centre and both sides) to the camera's resting position (`CameraRig.restingPosition()`). It lowers
  every tall tile that a line crosses below wall height. `Renderer.updateCutaway` applies it to every
  non-player actor on a tile the engine marks visible (`seen = 2`).
- Auto-framing: `Renderer.reframe()` uses `CameraRig.distanceToFrame()` to find the smallest distance
  that keeps every visible actor inside the viewport, with a bottom margin for the HUD. It sets it
  as `frameDist`. The camera uses `max(userDist, frameDist)`, so it only ever zooms out. An explicit
  zoom-in overrides the framing until the next turn.
- Lighting follows the engine's sight. The renderer computes `visibleRadius(state.area, player.pos)`
  from `seen` and calls `LightRig.setSightRadius()`. Fog starts beyond that radius (`fogRange`) and
  the player light reaches it.
- Actor light floor. `ActorLayer` gives actors their own copies of the shared model materials, so
  terrain is never touched. `setLightFloor(k)` sets an emissive floor (the base colour lifted 30% toward
  white, × k). `LightRig.actorLightFloor` sets k per area: 0.3 at the darkest, 0.06 when bright, and 0.05
  under a sun. Faded (ghost/sneak) copies keep it.
- Faction rings use `fog: false, toneMapped: false` (the hp bar already did).

## Regression tests
- src/client/render/visibility.test.ts: perspective occluder (the duct geometry; the old wedge
  missed it), camera framing / zoom precedence, fog and player light follow the sight radius,
  light floor by darkness, actor-only materials and the floor on faded copies, ring material,
  `visibleRadius`.
- e2e/render.spec.ts "actors on visible tiles are drawn in dark areas (fixture-ship ductworks)":
  ship seed 7 area 1, an enemy 5 tiles away in each direction. It must be shown and on screen, and
  pixels at 30/50/80% of its height must be lit (max channel ≥ 0x28). Before the fix they were
  0x00 to 0x15 or off screen.
