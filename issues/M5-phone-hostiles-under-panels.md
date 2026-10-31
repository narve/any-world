# Phones: hostiles were still drawn under the bottom panels (bag button, context row/column, strip)

- Severity: major (M5 mobile playtest, round 2)
- Area: renderer camera framing (src/client/render/camera.ts, src/client/render/index.ts)
- Status: fixed

## Evidence
Round-2 touch runs, `extraAudit` (screen points of every visible actor checked with
`document.elementFromPoint`):
- iPhone 15 portrait, mimic world: `hostile:intern-adventurer under aw-panel` (under the bag button).
- Pixel 7 portrait, russetid, turn 0: `hostile:russekortjeger under aw-ctx`, while a ~110 px band of empty
  map was left under the goal bar (docs/archive/progress/M5/pt-mobile-r2-pixel7-portrait-1-start.png).
- iPhone 15 landscape, cyberpunk: `mist-drone` / `logo-weevil under aw-ctx`, `process-server under aw-strip`.

Reports: tests/review/m5/reports/m5-mobile-pt-r2-*.json (`hiddenActors`).

## Root cause
1. Framing around panels (`CameraRig.setOccluders`) only ever zoomed out. On a narrow phone the default
   distance is already close to `MAX_DIST` (about 27 of 30 on an iPhone in portrait), so zooming out could not
   free the actor, and the camera never used the free band above it.
2. The panels only reached the renderer through `Renderer.setOverlayRects`, and the game never called it.
   The round-1 issue asked the controller to do this on desktop layouts only, and it was not wired at all.
   Phones therefore framed as if no panel existed.

## Fix
- **Shift before zoom.** `CameraRig.frame(points, from, { player })` returns a camera distance and an
  image shift (CSS px). At each distance, from the player's zoom outwards, it tries these shifts in order:
  - no shift;
  - the current shift, so the view does not wander from turn to turn;
  - shifts on a 17×17 grid, up to `PAN_SHARE` (60 %) of the framed half-size, shortest first.

  The first one that keeps every framed actor's feet and head inside the margins and out from under every
  panel wins. With a shift, the player's own feet and head must also stay on screen and clear of the panels.
  The shift is applied as an extra projection view offset, eased in `update()` and snapped by `settle()`.
  Because picking, `tileToScreen` and the map overlay all project through the camera, they follow it.
  `distanceToFrame` keeps its zoom-only behaviour.
- **The renderer finds the panels itself** (`Renderer.autoOverlays`, default true). Once the camera
  rests, and every 500 ms while it stays at rest, `probeOverlays()` hit-tests each framed actor's feet,
  middle and head with `document.elementFromPoint`.
  - Elements inside the renderer's own container (map labels) never count.
  - For any other hit, `overlayPanel()` climbs to the panel the element belongs to: the largest ancestor
    that leaves the player's screen point uncovered, stays under a third of the viewport and still takes
    touches (wrappers with `pointer-events: none` are layout, not panels).
  - That element is kept and measured again on every reframe and probe. It drops out when it leaves the
    page or is hidden, as with a dismissed narration or a toast.
  - A new or moved panel triggers a reframe.

  Rects passed to `setOverlayRects` still apply, combined with the found ones. The fix therefore works on
  phones, tablets and desktops without controller wiring. `setViewportInsets`, `resize` and `rotateCamera`
  now reframe and probe again.
- Dev/test accessors: `autoOverlayRects`, `clearAutoOverlays()`, `rig.pan` / `rig.panTarget`.

## Regression tests
- src/client/render/m5-phone-framing.test.ts:
  - iPhone 15 portrait panel layout: a hostile below the player that plain framing leaves under the
    ticker is reached by shifting the view up, with no zoom. Zoom-only framing would have needed a larger
    distance. The player stays between the HUD and the ticker.
  - The shift eases in and `settle` snaps it.
  - A still-valid current shift is kept.
  - With nothing under a panel there is no shift and no zoom.
  - An unescapable panel falls back to zooming out.
  - Landscape context column: the view shifts sideways.
  - `overlayPanel` picks the panel wrapper and never the page, the map container or a panel over the player.
- e2e/render-phone-panels.spec.ts (iPhone 15 portrait/mimic, Pixel 7 portrait/russetid in bokmål,
  iPhone 15 landscape/cyberpunk):
  - After the camera rests, no visible actor's body or tile point resolves to a page element (the
    review's own audit).
  - A hostile is then moved onto up to three visible floor tiles drawn under panels, and the audit must
    still come back empty.
- e2e/render-m5.spec.ts: the desktop overlay test now accepts a shift or a zoom-out (never a zoom-in).

Screenshots: test-results/shots/M5-render/phone-panels-*.png. The Pixel 7 start view now uses the band
under the goal bar, and the Ticket Inspector is fully in view.
