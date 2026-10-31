# Items were only single-letter discs everywhere; no item thumbnails were rendered

- Severity: major (M5 desktop playtest, Viking backpack and Western trade)
- Area: renderer (src/client/render/thumbnails.ts, src/client/render/index.ts)
- Status: fixed (hotbar + backpack); trade list needs a one-line client change (see below)

## Evidence
In the Viking backpack three carried items showed as "O", two as "C" and two as "H"
(docs/archive/progress/M5/pt-desktop-r1-viking-08-backpack.png), and the trade list looked the same. The
client was already wired for pictures: game-controller.ts checks `renderer.itemThumbnail` and
common.ts renders `.aw-glyph.has-thumb` images. But `typeof window.__anyworld.renderer.itemThumbnail`
was `'undefined'` because the renderer never implemented it.

## Fix
`Renderer.itemThumbnail(defId): string | null` is now implemented through `ItemThumbnailer`
(src/client/render/thumbnails.ts):
- Each item's model is drawn once, on the game's own WebGL context, into one shared 128 px offscreen
  render target. It uses a small studio light rig and a three-quarter view from the front. The camera
  is fitted to the projected bounding box, so the item fills about 86% of the square. Long thin
  items such as staffs and swords lie along the diagonal.
- The pixels are read back, converted from linear to sRGB (render targets skip the output
  conversion), flipped, filtered down to 64 px, and cached as a PNG data URL for each def id. A new
  world clears the cache.
- The previous render target, clear colour and shadow setting are restored after each draw, so the
  main frame is not affected.
- It returns null for def ids the world does not have, before setWorld, and while the context is
  lost. The lost-context null is not cached, so the next call after a restore tries again.
- It returns the item's real look. The client shows it only for identified items (view.ts skips
  `knowledge === 'unknown'`, and `glyph()` checks again). Unknown items keep the appearance-coloured
  glyph, so a thumbnail never reveals what an unidentified item is.

## Not in renderer scope (client)
`tradeView` in src/client/view.ts does not pass `thumbs` to the trade rows, so trade still shows
glyphs. The client owner should apply `x.thumbs(defId)` to the trade entries the same way slots do.

## Regression tests
- src/client/render/m5-fixes.test.ts "item thumbnails": caching, 64 px output, framing of every item
  model in 4 worlds, state restore, unknown ids, lost context, empty render, world change, sRGB/flip.
- e2e/render-m5.spec.ts "hotbar and backpack show rendered item thumbnails": the in-game renderer
  exposes the function, every item gives a distinct PNG, the backpack shows decoded 64 px non-empty
  pictures, and unknown glyphs carry no picture.
  Screenshot: test-results/shots/M5-render/viking-backpack-thumbs-close.png
