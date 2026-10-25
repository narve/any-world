# Hostiles (including the final boss) could stand under the context buttons, hotbar or HUD panel

- Severity: minor (M5 desktop playtest, Western final area)
- Area: renderer camera framing (src/client/render/camera.ts, src/client/render/index.ts)
- Status: fixed in the renderer; the game controller still has to pass the panel rects (see below)

## Evidence
Absalom Vane and his summoned Tinplate Prospector stood partly behind the Search/Wait buttons and the
hotbar (docs/progress/M5/pt-desktop-r1-western-34-boss.png, …-35-target-boss.png). In another run a
visible Dust Coyote was projected inside the top-left HUD rect. Auto framing kept actors inside the
viewport margins, but on desktop the corner panels are not insets (they are deliberately not passed
as insets, because insets would shrink the whole view), so nothing counted them as covered.

## Fix
- `CameraRig.setOccluders(rects)` and `underOverlay()`: `distanceToFrame` now rejects a camera
  distance when any framed point (an actor's feet or head) projects inside an overlay rect, grown by
  6 px. Zooming out moves everything toward the follow target, so the search always finds a clear
  distance. A rect that covers the view centre (where the player stands) is ignored, because it could
  never be escaped.
- `Renderer.setOverlayRects(rects)` takes viewport CSS px rects, such as `getBoundingClientRect()`
  of the panels. It converts them to canvas-relative px (again on resize), reframes immediately, and
  `overlayRectsInUse` reports them. Unlike `setViewportInsets`, it does not move the view centre.
- The dev page accepts `&overlays=l,t,r,b;…` and draws the pretend panels.

## Wiring (client owner, src/client/game-controller.ts `updateInsets`)
On tablet and desktop layouts, pass the measured panels:
`if (typeof r.setOverlayRects === 'function') r.setOverlayRects(compact ? [] : this.host.ui.panelRects().hud);`
`panelRects().hud` already lists the HUD, goal bar, rules, log, hotbar and context-button parts.

## Regression tests
- src/client/render/m5-fixes.test.ts "auto framing keeps actors out from under overlay panels": the
  playtest's desktop layout rects; a boss below the player whose feet sit under the context buttons
  is framed above them; an actor under the HUD is pulled out; actors clear of the panels do not
  change the zoom; a rect over the centre is ignored.
- e2e/render-m5.spec.ts: on the dev page, a panel placed over the farthest visible actor makes the
  camera zoom out until neither the actor's feet nor its head is under it; `&overlays=` draws and
  applies the rects. Screenshot: test-results/shots/M5-render/overlay-framing.png
