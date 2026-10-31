# Overhead hp bars are unreadable: the fill is drawn under the semi-transparent dark background

- Severity: major
- Area: renderer (src/client/render/actors.ts HpBar)
- Status: fixed

## Evidence
`bgMat` was `transparent: true, opacity: 0.8` while `fgMat` was opaque. three.js renders the opaque
list before the transparent list, so renderOrder 998/999 never compared the two meshes: the dark
background was blended over the fill. At 20/32 hp the fill (#5fe08a) read back as #233d31.
Screenshots: docs/archive/progress/M1/playtest-western-70-hpbar-zoom.png, playtest-ship-12-fight.png,
playtest-western-61-boss-fight.png.

## Fix
Both bar materials are now `transparent: true` (fill at opacity 1), `depthTest/depthWrite: false`,
`fog: false`, `toneMapped: false`. They share the transparent list, where renderOrder draws the
background first and the fill on top, and the status colours come out exactly as specified.
Renderer gained test helpers `hpBarScreen(actorId)` and `samplePixel(x, y)` (same-task readPixels).

## Regression tests
- src/client/render/render.test.ts "HpBar" (material flags, render order, colours)
- e2e/render.spec.ts "hp bar fill is drawn on top of its background" (pixel check: fails with the old
  opaque fill, samples #233d31; passes after the fix)
