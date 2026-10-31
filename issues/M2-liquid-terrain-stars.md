# Teen flood / seep water renders as spiky blue star fragments instead of water

- Severity: minor
- Area: renderer (src/client/render/surfaces.ts PatchLayer, src/client/render/tiles.ts liquid terrain material)
- Status: fixed

## Evidence
docs/archive/progress/M2/playtest-r1-ui-teen-gm-rule.png and playtest-r1-ui-teen-persuade.png show bright blue blotches with sharp star-shaped spikes. playtest-r1-fixture-teen-area1-arrive.png shows a sparkly blue cloud. By comparison, the western cistern ('water' floor pattern) in playtest-r1-fixture-western-area3-arrive.png looks right.

## Root cause
1. Geometry: `PatchLayer` pushes the border vertices of a soft patch outward (pad 0.12) so the fade overlaps the floor. The push direction was decided per tile, from the vertex's position inside that tile (u = 0 → −x, u = 1 → +x), whenever its alpha was below 1. Neighbouring tiles share grid points, but each pushed its own copy in its own direction. On a shared edge whose corner touches the outside, one tile moved the corner up and the other moved it down. Their triangles crossed and folded over each other, and these folds were the "star spikes".
2. Material: liquid terrain used the shiny `liquidMaterial` (roughness 0.12 with a ripple normal map and a saturated emissive). In bright or point-lit rooms, this sparkled as glints (the "sparkly cloud").

## Fix
- New `patchGrow(u, v, inside)` (surfaces.ts): a vertex moves along an axis only when every tile beyond it on that axis is outside the patch. The push then depends only on the grid point, so all tiles agree on shared vertices and nothing can fold. `PatchLayer.foldedTriangles()` counts flipped or degenerate triangles, for tests.
- Liquid terrain now uses `flatLiquidMaterial`: the same ripple-arc 'water' pattern as a water floor, drifting slowly (frozen under reduce motion), matte (roughness `LIQUID_TERRAIN_ROUGHNESS` = 0.55, no normal map, so no glints), translucent (`LIQUID_TERRAIN_OPACITY` = 0.72), with a low emissive (the terrain's own emissive when it has one). Water tiles (`~`) keep their shiny material.

## Regression test
- src/client/render/fixes-m2.test.ts, "liquid terrain patches": zero folded triangles, and shared vertices land on the same spot for single, disc, L-shaped, diagonal and ring patches. Teen seep water is matte, with no normal map and opacity below 0.8.
- e2e/render-fixes-m2.spec.ts: spawns a radius-2 seep around the player in teen areas 0 and 1 (what "The Water's Coming" does), checks `liquidTerrainInfo()` and writes docs/archive/progress/M2/fix-teen-liquid-area{0,1}.png.
