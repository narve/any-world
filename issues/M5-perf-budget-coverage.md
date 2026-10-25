# DoD #12: the performance budget did not check bundle size or triangles, and checked draw calls only on fixtures

- Severity: minor (M5 DoD audit)
- Area: renderer performance tests (e2e/render-mobile.spec.ts, tests/render/bundle-size.test.ts),
  renderer draw calls (src/client/render/tiles.ts, items.ts)
- Status: fixed

## Evidence
No test asserted chunk sizes. The main chunk was 829 kB (268 kB gzip) and render was 709 kB (188 kB
gzip). e2e/render-mobile.spec.ts checked DRAW_CALL_BUDGET=250 only for the fixture-* worlds and never
checked triangles.

## Fix
- tests/render/bundle-size.test.ts (vitest, about 3 s) builds the static bundle (`vite build --mode
  static`) into a temporary directory, never touching dist/, and asserts these gzip budgets: main entry
  < 300 kB, render chunk < 200 kB (and no WebGLRenderer in the entry), CSS < 40 kB, web workers < 150
  kB, every other chunk < 40 kB. Current sizes: main ≈ 273 kB, render ≈ 187 kB, balance worker ≈ 111
  kB, largest world ≈ 20 kB.
- The draw-call test in e2e/render-mobile.spec.ts now covers every area of every world in
  content/worlds (20 worlds) on both the high and low tiers. It also asserts TRIANGLE_BUDGET = 400k.
- Extending the test showed a real overrun: viking-lawspeaker-althing area 0 cost 257 draw calls on
  high. Doors (8 meshes each, all casting shadows) and animated terrain models (one mesh per
  primitive per placed copy) were not compacted. Now:
  - Door frames are merged per material with `compactModel`, and the moving panel keeps its own
    merged meshes. The threshold shares the jambs' material, so a door costs ≤ 5 meshes instead of 8.
  - Animated terrain templates are compacted before cloning, keeping their animated parts.
  - Floor item templates are compacted, and their merged geometries are disposed with the layer.
  Worst case is now 243 calls on high and 158 on low. Worst triangles:
  294k (microscopic-root-nodule area 2).

## Regression tests
tests/render/bundle-size.test.ts; e2e/render-mobile.spec.ts "every area of every world stays under
250 draw calls and 400000 triangles on high/low"; src/client/render/m5-fixes.test.ts "animated
terrain models are compacted" and "doors are compacted".
