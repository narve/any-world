# Ship Ductworks maze walls out of sight are low-contrast translucent blue slabs

- Severity: minor
- Area: renderer (src/client/render/tiles.ts InstLayer / walls / wall edges)
- Status: fixed

## Evidence
In docs/archive/progress/M2/playtest-r1-fixture-ship-play-0600.png and playtest-r1-fixture-ship-layer-dialogue.png, the maze walls beyond the lit area are large flat blue panels. They are hard to tell apart from floor or void, so the corridor structure is hard to see.

## Root cause
Every remembered (seen = 1) instance was multiplied by one fog-of-war tint, REMEMBER = (0.36, 0.38, 0.48). That tint is strongly blue. Wall caps, sides and the top-edge outline bars all got the same tint, and in the dark Ductworks (abyss backdrop, blue ambient) they merged into one flat blue slab. The outline lost its contrast against the cap, and the dark-blue cap read like the backdrop.

## Fix
- `InstLayer` takes a per-layer remembered tint.
- Wall bodies use `REMEMBER_WALL` = (0.27, 0.28, 0.32): darker and neutral, not blue.
- Wall-edge outline bars use `REMEMBER_EDGE` = (0.8, 0.82, 0.9), so the outline stays near full brightness.
- The box/rough outline material has a small emissive (`WALL_EDGE_GLOW` = 0.35) of its own colour, so the top edge still reads against a dark backdrop with no light on it.
- Result: out-of-sight walls are dark blocks with a crisp light outline, as in area 0. See docs/archive/progress/M2/fix-ship-ductworks-remembered.png.
- `AreaView.rememberedContrast()` / `Renderer.rememberedWallContrast()` report the luminance of the remembered cap, outline and floor, for tests.

## Regression test
- src/client/render/fixes-m2.test.ts, "remembered walls":
  - Ductworks: outline − cap > 0.08 and cap − remembered floor > 0.05.
  - Every outlined fixture area keeps its outline above its cap.
  - Remembered wall and outline instances take their own tints, and the wall tint is neutral.
- e2e/render-fixes-m2.spec.ts walks the Ductworks maze, asserts the same contrast and writes the screenshot.
