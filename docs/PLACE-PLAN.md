# PLACE — worlds anchored to a real place (OpenStreetMap)

Status (2026-11-10): **P1 and P2 are built** (engine generator, patch format, renderer ground colours and
trees, fetching, the picker with its map preview); see "What was built" at the end, which also lists where the
build departs from this plan. P0 was skipped on the owner's word (ASCII maps would not tell much): the picker's
map preview and the 3D screenshots in `docs/progress/place/` took its place. P3 (the world prompt) and P4 are
not started: until P3 a chosen place is put under the opening area by the game itself. Owner's brief: *the game is not engaging enough; anchor it to the
actual world. World creation should pull buildings, streets and squares from the map, so a world is
recognisable even when the fiction is wild.*

## 1. What the player gets

On the start page, *Create a new world* grows a **Place** field next to the prompt: search a place by name
("Torvet, Kristiansand", "Kuben vgs"), or *Use my location*, with recent places remembered. The picker shows
a tiny map of what will become the first area (the rasterised tiles, see §3) and the landmarks found there
("Torvet, Domkirken, Markens gate, Narvesen, …"). The prompt stays free: *"a zombie outbreak the night of the
school ball"* + the school's address gives a run that starts on the real schoolyard, whose streets and buildings
carry their real names, and whose NPCs work in the real bakery, library and station.

The layout is real; the dressing is the model's. "Does not have to be very similar": a 56×40-tile map is about
160 × 115 m at ~2.8 m per tile, so one area is one square or campus with its surrounding blocks, and a run
visits 3–5 such patches (or jumps into a landmark's interior, or into a non-place area such as a dream, between
them). Streets become open tiles of their real width class, building footprints become walled interiors with
a door on the street side, squares and parks are open ground with the real trees, water is water.

Why this helps engagement: recognition ("that's my school!"), a reason to share worlds with people who know the
place, and the school worlds (KKG, Kuben, Tangen) can be rebuilt on their real campuses.

## 2. Data source and its rules

**OpenStreetMap** via two public services, both callable from the browser (CORS on) and from Node:

- **Nominatim** (`https://nominatim.openstreetmap.org/search`, `/reverse`): place name → lat/lon and a display
  name. Policy: at most 1 request/s, an identifying `User-Agent` or `Referer` (browsers send the Referer). No
  autocomplete-on-every-keystroke: search on Enter / the button.
- **Overpass API** (`https://overpass-api.de/api/interpreter`, fallback mirrors `overpass.kumi.systems`,
  `maps.mail.ru/osm/tools/overpass`): one query per patch, `out geom` so coordinates come inline. Typical
  answer for a 120 m radius in a town centre: 100–500 KB, 2–20 s; it is rate-limited and sometimes down, so
  timeouts (25 s) and a graceful fallback (§7) are part of the design, not an afterthought.

Query shape (radius R around the point): ways/relations with `building`, `highway`, `natural=water`,
`waterway=riverbank`, `leisure` (park, pitch, playground), `landuse` (grass, retail, …), `amenity`/`shop`/
`tourism` (for names and types), `barrier` (wall, fence, hedge), `railway`; nodes with `natural=tree`,
`amenity`, `shop`, `highway=bus_stop`. Multipolygon relations: outer rings only.

**Licence (ODbL):** show "© OpenStreetMap contributors" wherever a place-based map or its preview is shown
(picker, loading screen, world card, in-game help/about), and in the exported world file's `place.attribution`.
Keep the OSM `id`s of features in the patch, so the data is traceable.

**Privacy:** *Use my location* sends coordinates to Nominatim and Overpass (third parties) and the chosen
place name and coordinates end up in the world file (`place`), which is shareable by design. Say so in one
line under the field; the player confirms the resolved place name before anything else happens. The server
never logs coordinates (if the proxy of §6 is built: cache key only, rounded to ~50 m).

**Norway option, later:** Kartverket's open FKB/N50 data (WMS/WFS) has better building footprints than OSM in
Norway; the patch format below is source-neutral so a second fetcher can be added without touching the engine.

## 3. Data model: the patch is vector data, the engine rasterises

The World Spec must stay self-contained JSON (world files, rooms, bots, deterministic replays), so the map
data lives in the spec. It is stored as **simplified vector features in local metres**, not as tiles, and a
new map generator rasterises it at run start. That keeps party scaling (a 12-player room gets a 91×65 grid of
the same patch at finer resolution), lets `size` pick the radius, keeps the JSON small (~10–20 KB per patch,
coordinates rounded to 0.5 m) and keeps mapgen a pure, deterministic function of the plan, as today.

```ts
// src/schema/place.ts (new)
PlacePatch {
  id: Id;                      // "torvet", "domkirken" (the model refers to these)
  name: string;                // "Torvet" (≤60)
  kind: 'outdoor' | 'interior';// §4.3 interiors
  centre: { lat, lon };        // for attribution/debug and the preview, not used by the engine
  extent: number;              // metres across the patch (square); 90 small … 160 large
  features: PlaceFeature[];    // ≤ 400
}
PlaceFeature {
  kind: 'building' | 'road' | 'path' | 'square' | 'green' | 'water' | 'rail' | 'barrier' | 'tree' | 'poi';
  name?: string;               // "Markens gate", "Kristiansand domkirke", "Narvesen"
  type?: string;               // OSM subtype, trimmed: "school", "church", "bakery", "primary", "footway", "park"
  osm?: string;                // "w123456" (attribution/trace)
  width?: number;              // roads/paths/barriers: metres
  levels?: number;             // buildings
  geometry: number[];          // flat [x0,y0,x1,y1,…] metres from the patch centre; polygon (closed) or line; a point for tree/poi
}
WorldSpec.place?: { name, displayName, lat, lon, source: 'osm', fetchedAt, attribution, patches: PlacePatch[] }  // ≤ 6 patches
AreaPlan.generator: Generator | 'place';  AreaPlan.patch?: Id;   // 'place' requires patch
```

Projection: equirectangular around the patch centre (`x = Δlon·cos(lat0)·111320`, `y = −Δlat·110540`), fine at
200 m. Clipping: features cut to the patch square with a 1-tile margin; buildings whose clipped footprint is
smaller than 2×2 tiles are dropped (or kept as solid blocks). Roads carry a width from the highway class
(primary/secondary 3 tiles, residential/tertiary 2, service 2, footway/pedestrian 1; `width`/`lanes` tags win).

`validateWorldRefs` gains: every `patch` ref exists; `generator:'place'` ⇔ `patch` set; `place.patches` ids
unique. Backward compatibility is not a concern (see the project's stance), only graceful failure.

## 4. Engine: the `place` generator

`src/engine/mapgen/generators/place.ts`, `genPlace(ctx)`. The patch arrives through `ctx` (today
`makeContext` gets `plan.size` and `plan.params`; it also gets `plan.patch` resolved to the PlacePatch, so
`generateArea(plan, world, …)` looks it up in `world.place`). Metres per tile = `extent / width`. Paint order,
later wins:

1. **Ground**: everything inside the patch is `floor` (the "outdoor ground" region, like `town`'s ground).
2. **Green** polygons → floor with surface hint `grass` (§4.2); **water** → `water` tiles (impassable, as now);
   **rail** lines → floor with surface `rail` (walkable; trains are the model's business).
3. **Roads and paths** → floor with surface `road`/`path`, rasterised as thick lines; a road over water is a
   bridge (floor wins).
4. **Barriers** (walls, fences, hedges) → `wall` tiles 1 wide; low fences could be a blocking terrain later.
5. **Buildings** → outline `wall`, interior `floor` with its own region; 1 door facing the nearest road tile
   (2 for footprints > 60 tiles, a back door 25 %), using the same partition logic as `town` for interiors
   ≥ 6×2 (an inner wall with a door). Footprints whose interior would be < 3×3 become solid wall blocks.
   Buildings touching the map border are cut by the border wall (finalize closes the border anyway).
6. **Trees** → a blocking, sight-blocking terrain (`place-tree`, injected TerrainDef) on their exact tile where
   the tile is open ground, never on a road or door.

Then the normal `finalize` (border closing, `connectAll` with `doors: true` so a courtyard or a building with
no road frontage gets a carved door, `chooseStartExit`, lamps as `lighting.lamps.frequency`). Regions get the
real names: every building region is named by its OSM `name`, else its `type` ("Bakery"), else "building";
streets and squares are regions too (one per named road: tiles of the road's raster share the region, so the
GM and the discovery hook see "Markens gate"). `pruneSpurs`/`shortcuts` are 0 here (real dead ends stay).

**4.1 Scale and recognisability.** The test of this plan is §8 P0: rasterise 4–5 real places to ASCII and
look. Expect 2.5–3.2 m per tile to be the sweet spot: at 56×40 a cathedral is ~15×8 tiles, a shop 4×3, a
residential street 2 wide. Small (32×24) is only for a courtyard or a single campus.

**4.2 Surfaces (cosmetic).** Today an area has one floor and one wall style, so streets, grass and plaza would
all look the same. Add a cosmetic `Tile.surface?: 'road' | 'path' | 'pavement' | 'grass' | 'rail' | 'plaza'`
that the renderer uses to tint/texture floor tiles (derived from the area's `floor` colour: roads darker,
grass green-shifted, plaza the base). No gameplay meaning, so no schema or GM impact; the generator sets it,
`toAreaMap` keeps it. (Alternative considered: injected TerrainDefs for each surface. Rejected: TerrainDef is
gameplay, `terrains` is capped at 10 and the model needs them, and `onStand` would be an invitation to farm.)
Building wall heights from `levels` can follow once the renderer supports per-region wall height (not now).

**4.3 Interiors of landmarks.** A second patch kind: `interior` of one chosen building (the school, the church,
the station). The footprint becomes the outer wall and the `building` generator's hallway-and-rooms logic is
constrained to the footprint mask (today it assumes the whole rectangle). OSM rarely has indoor data, so the
rooms are invented; only the outline is real, which is enough to read "this is the long L-shaped school
block". Doors: the real entrances if `entrance=*` nodes exist, else facing the road. This is P4 work; v1 uses
the plain `building` generator with the real building's name.

**4.4 Tests.** Fixtures in `tests/fixtures/osm/*.json`: recorded Overpass answers for 3–4 places (a Norwegian
town square, a school campus, a village with sparse data, a dense foreign city block). Tests: patch builder
(projection, clipping, widths) on the fixtures; `genPlace` invariants (`validateMap`, `checkMap`) over the
50 seeds × 3 sizes like every generator in tests/mapgen/generators.test.ts, plus party sizes; ASCII snapshots
of each fixture at large; region names present; determinism. No network in tests (fetch mocked as the LLM
tests do). `tools/mapgen-ascii.ts` learns `--patch <fixture>`.

## 5. Fetching and the picker (client, browser-safe module)

`src/place/` (shared by browser and server, like `src/llm/`):

- `geocode.ts`: Nominatim search and reverse; returns `{ name, displayName, lat, lon, type }`, ≤ 5 hits.
- `overpass.ts`: builds the query for (lat, lon, radius), fetches with timeout and one mirror fallback, parses
  elements into raw features. Honest errors: `PlaceError` with kinds `network | timeout | busy | empty`.
- `patch.ts`: raw features → `PlacePatch` (projection, simplification, clipping, width classes, names/types).
  Also `patchSummary(patch)` for the UI and the prompt (counts, named features sorted by size/importance).
- `brief.ts`: the PLACE paragraph for the world prompt (§6).
- `cache.ts`: patches by rounded (lat, lon, extent) in IndexedDB/localStorage, 7 days; recent places list.

UI (`src/client/ui/components/place-picker.ts`, inside the *Create a new world* card): a text field with
search button, *Use my location* (browser geolocation, asks only when pressed), recent places as chips, the
resolved display name with a *change* link, a preview canvas (the rasterised patch at large, drawn from a
`genPlace` dry run, 2–3 px per tile, with the attribution line) and the landmark list with the chosen focal
point highlighted. Choosing a landmark re-centres the main patch. `StartOptions.place?: PlaceChoice` carries
the resolved patches into `createWorld`. en + nb strings; phone layout (the preview under the field, full
width). Back button: the picker is part of the start page, no history entry.

Secondary patches: from the main patch's named landmarks, the picker (or automatically, by importance:
school > church > station > square > park) picks up to 3 more centres within ~400 m and fetches their patches
after the player presses *Create*, during the loading screen, before the world call. Fetching is ~5–20 s per
patch; patches fetch in parallel (respecting the 1 req/s geocoder, which they do not need).

Loading screen: show the place preview while the 5-minute world call runs (the PLAN backlog's "looks hung"
item wants something to look at there anyway), with the real landmark names under it.

## 6. Prompt and pipeline

**User message** (`worldUserMessage`, new PLACE block when `opts.place` is set):

```
PLACE: the player wants this world set in a real place: "Torvet, Kristiansand, Norway" (a town square).
The map layouts of these areas are taken from the real map and are fixed; you dress them.
Patches you may use (set generator "place" and patch "<id>"; size is given, keep it):
- torvet (large): square "Torvet"; streets Markens gate, Rådhusgata, Gyldenløves gate, Kirkegata; buildings
  Kristiansand domkirke (church), Rådhuset (townhall), Narvesen (kiosk), Café Generalen (cafe), 12 unnamed
  buildings; a park with 18 trees; a fountain.
- domkirken (medium, interior): inside Kristiansand domkirke (church), 1 real entrance.
- …
Use 2–4 of them, in a sensible walking order; you may add 1–2 areas of your own (any generator) between or
after them. Name place areas and their transitions after the real streets and buildings, put NPCs where they
would work (a baker in the bakery), and write gmNotes that mention the real landmarks. Keep names exactly
as given. Do not write the "place" block of the World Spec: the game adds it.
```

The system prompt's generator table gets one line for `place`. The brief is ~300–800 input tokens; output size
is unchanged (the model writes no geometry), which matters because worlds already run at 29.9k of the 32k
output cap. If `recentWorlds` and a place are both set, the "make it different" line still applies to genre and
tone, not to the place.

**Pipeline** (`generate.ts`): zod-parse the reply → attach `world.place = opts.place` (`finaliseWorld` grows a
`place` input) → `validateWorldRefs` (patch refs) → repair turns as today, with the patch list repeated in the
repair message if a ref was wrong → balance as today (`genPlace` runs inside the bots' `createGame`, so the
simulations play the real layout; its CPU cost must stay in the generators' budget: median < 50 ms).

**Offline preset** cannot call a model; with a place chosen it shows "A real place needs the AI" and offers the
plain demo worlds (later: dress a recorded world's first area over the patch).

**GM:** `gm-context` already lists discovered region names, which now are real street and building names, so
"You turn into Markens gate" costs nothing. Add `world.place.displayName` to the GM system prompt's world
summary (gm.ts) so the game master knows the place is real and may use it. The mapgen discovery hook can also
raise a small toast with the region name the first time the player enters a named street or building
(`src/client/map-overlay.ts` / log), which is the cheapest recognisability win in the whole plan.

**Server proxy, optional (P4):** `GET /api/place?lat&lon&extent` on the Node server: same `src/place` code,
disk cache under the data dir (`server/data-dir.ts`), one upstream request per cache key at a time. Reasons:
the Overpass rate limit is per client IP, a shared cache serves a school class making 30 worlds of the same
square, and the static Pages build keeps calling Overpass directly. No AI budget involved. Needs outbound
access from the Dell to the OSM hosts; ask through `deploy/DELL-REQUESTS.md` only if UFW blocks egress.

## 7. Failure modes and fallbacks

- **Overpass down or slow** (common): one mirror retry, then the loading screen says "The map service is busy;
  continuing without the real map" and the run proceeds with no PLACE block (today's behaviour). Never block
  the 5-minute world call on a map fetch longer than ~40 s.
- **Sparse data** (a village, a field): fewer than ~6 buildings or no roads → the picker says so before *Create*
  ("Little map data here. Try the town centre or a named building.") and still allows it.
- **Model ignores the layout** (chooses `town`): validation error "area 1 must use generator 'place' with one of
  the patches" is a repair turn; after two repairs, the pipeline rewrites the first area's generator itself.
- **The map is a maze of back yards**: `connectAll` carves doors; the ASCII spike (P0) decides whether private
  yards (`landuse=residential` without roads) should be filled as `wall`/hedge instead of floor.
- **Token cap**: no output growth; the PLACE block is input only.
- **Privacy**: the one-line notice and the confirm step; no coordinates in server logs.

## 8. Milestones

| # | What | Exit check |
|---|---|---|
| P0 | **Spike** (one day): `tools/place-ascii.ts` — Nominatim + Overpass fetch, projection, rasterise to 56×40 ASCII (`renderAscii`) for Torvet (Kristiansand), KKG, Kuben vgs, Tangen vgs, one village, one foreign block. Pick m/tile, the feature set, widths, what to do with yards. Record the Overpass answers as the fixtures of §4.4. | The owner recognises the places in ASCII. |
| P1 | **Engine**: `src/schema/place.ts`, `AreaPlan.patch`, `WorldSpec.place`, ref validation, `genPlace` (§4, without 4.3), `Tile.surface` + renderer tint, region names, tests and snapshots. `BUILD_LOG.md` note for the contract change. | tests/mapgen green over 50 seeds × 3 sizes × fixtures; a fixture world with a place area plays in the browser. |
| P2 | **Fetch + picker** (§5): `src/place/*`, picker UI with preview and attribution, recent places, geolocation, en/nb, phone layout, cache. | Choosing a place shows its preview; a world created with it starts on that map (model told through P3's brief, or a stub that forces area 1). |
| P3 | **Prompt + pipeline** (§6): PLACE brief, generator table line, attach/validate, repair messages, GM summary. Tune on ≥ 5 generated worlds over 3 places and 2 languages; sim (`npm run sim`) and a playtest note in `docs/playtest/`. | Worlds use 2–4 patches with real names and sensible NPC placement; win rates inside the balance band. |
| P4 | **Polish**: discovery toasts with real names; interior patches (§4.3); the server proxy and cache; party-size check in rooms; rebuild the three school worlds on their real campuses as featured demo worlds (keep the staff-name rules); wall height from `levels` if the renderer grows per-region heights. | School worlds live on their real maps; a 12-player room plays a place at 91×65. |

Order matters: P0 before anything else, because it answers the only real unknown (does a 160 m patch of
OpenStreetMap read as the place at ~3 m per tile?). P1–P3 are each a day or two of focused work with tests;
P4 is a backlog.

## 9. Open questions for the owner

1. Which places first for the spike: Torvet in Kristiansand and the three schools?
2. Should *Surprise me* ever pick a place (a random well-mapped town square), or is a place always the
   player's explicit choice? (Plan assumes explicit.)
3. Is a shared world revealing its place acceptable by default, or should sharing a place-based world ask
   first? (Plan assumes a notice under the field is enough.)

## 10. What was built (P1–P2, 2026-11-10)

Code: `src/schema/place.ts` (PlacePatch, PlaceFeature, WorldPlace; `WorldSpec.place`, `AreaPlan.patch`, generator
`place`), `src/engine/mapgen/generators/place.ts`, `src/place/` (`overpass.ts`, `geocode.ts`, `patch.ts`,
`load.ts`, `apply.ts`), the client's `place-store.ts`, `place-preview.ts` and `ui/components/place-picker.ts`,
and the ground colours and trees in `src/client/render/tiles.ts`. Tools: `tools/place-fetch.ts` (records a
fixture), `tools/place-ascii.ts` (a fixture as the generator lays it out). Tests: `tests/place/`,
`tests/mapgen/place.test.ts` (7 recorded places × 3 sizes × 50 seeds, snapshots), `e2e/place.spec.ts` (pick a
place, see the map, start the run; it also writes the screenshots in `docs/progress/place/`).

Where the build differs from the plan above:

- **The ground is turned to the tile grid.** A town laid out at 30° to north (Kvadraturen) rasterised into zigzag
  walls with almost no room inside. `buildPatch` finds the dominant direction of the house walls and turns the
  patch by up to 45° (`PlacePatch.rotation`); the features are stored already turned. North is no longer exactly
  up; the preview does not show a compass yet.
- **Neighbouring houses share one wall** (the bigger footprint gives up the tile), so a row of narrow shops keeps
  its interiors. Footprints with fewer than 3 inner tiles are solid blocks.
- **Scale:** a large map spans the patch's 160 m; medium and small maps keep that scale and show the middle
  (§3 had `size` pick the radius). A party's bigger grid shows the same ground finer.
- **Start and exit:** the run starts outdoors nearest the middle of the patch (the place the player asked for)
  and the exit is a street tile at the far edge, instead of the shared far-apart chooser.
- **Unmapped open ground is `pavement`**, so the area's own floor style is the indoor floor; the floor texture is
  neutral on place maps and each tile carries its colour (a tint could not turn a red carpet into grass).
- **Trees are a cosmetic `Tile.prop` on a wall tile**, not an injected TerrainDef (no cap on `terrains` touched,
  nothing for the model to farm).
- **The sea:** `natural=coastline` lines are kept (`water`, type `coastline`) and the generator floods their
  right-hand side; a coastline with a gap in the patch floods nothing.
- **School and hospital grounds** (`amenity=school` areas) are fetched only to name their unnamed buildings.
- **Region names:** real names only (a building without one stays unnamed rather than "Bakery": the type is
  English and would show up in Norwegian worlds). The open ground is one region named after the patch.
- **No AI needed to try it:** with no usable provider, *Create* with a place chosen puts a ready-made world on
  the place (the offline demo generator), so the map can be judged without an API key.
- **Hidden from the model:** `WorldSpec.place`, `AreaPlan.patch` and the `place` generator are left out of the
  world prompt's schema text (`WORLD_DOC_OMIT`) until P3 hands the model the patches. The prompt is unchanged.
- **Not built from §5:** secondary patches (one patch per place for now), the preview on the loading screen,
  and choosing the extent. Barriers: only walls (`barrier=wall|city_wall|retaining_wall`), no fences or hedges.

Left for P3/P4 as planned: the PLACE brief and repair messages, several patches per world, the GM being told the
place is real, discovery toasts, landmark interiors, the server cache, the school worlds on their campuses.

## 11. District scale (trial on Tangen, 2026-11-10)

Owner feedback on the street-scale Tangen map: it is hard to see how it relates to the real Tangen. At 160 m
across, the map *is* the school building with invented rooms and a strip of river; nothing a local would
recognise it by (Aquarama, Bystranda, the hotel, the street grid) fits on it.

Trial, for the bundled *Tangen* example place only (`content/places/tangen.json`): `PlacePatch.scale: 'district'`.
The same 56×40 grid spans 400 m (about 7 m per tile) and is drawn like a tourist map:

- every building is **one room**; named buildings too small to enter at this scale get a 4×4 footprint;
  unnamed small houses are solid blocks;
- only named footpaths are drawn; beaches are sand;
- the **names are written over the map in the game** (streets, buildings, the beach; dimmer where not yet seen),
  through the map overlay;
- the patch is turned to line up with what lies within 120 m of its centre (the place asked for), and the Tangen
  patch is centred a little inland of the school so the river does not fill half the map.

Screenshots: `docs/progress/place/tangen-district-*.png`. Open questions if this becomes the default: the many
solid blocks of unnamed houses are noisy (merge them into city blocks, or drop them); the picker has no way to
choose the scale; a two-level world (district outside, street-scale interiors of the landmarks) is the natural
next step and fits P4's interiors.

**KKG too, with its own story (2026-11-11).** The bundled *KKG, Gimle* example (`content/places/kkg.json`) is now a
district patch as well (400 m, centred a little north-east of the school so Gimlehallen, the crematorium and
Oddernes kirke are on the map). Two additions, both carried by the place file:

- `world: "nb-kkg-talen"`: a place can name the ready-made world that is set there. Choosing the place then plays
  that world whatever is typed and whether or not an AI is configured; the picker says so. All four areas, the
  cast, the items, the goal and the recorded GM lines are kept; only the first area's layout is the real map.
- `PlacePatch.focus`: the building the story is about. The player arrives by a street at the edge of the map and
  the way on ("Lås deg inn i biblioteket") is inside that building, instead of starting in the middle and leaving
  by a street.

Known mismatches: the first area is still called *Mellombygget* and its recorded intro speaks of being indoors;
its indoor scenery (lockers, the wet floor) is scattered over the whole campus. Screenshots:
`docs/progress/place/kkg-district-*.png`. The district files are built by hand from a wider fetch;
`tools/place-bundle.ts tangen kkg kuben` would overwrite them with street-scale patches.

**Kuben too (2026-11-11).** `content/places/kuben.json` is a district patch (400 m around the school at Økern)
with `world: "nb-kuben-valget"` and the school as `focus`. Kuben is mapped as four buildings side by side (the
named one, two unnamed school wings and the strip between them), which gave three corridor-thin rooms; on a
district map the focus building now takes in the unnamed parts built onto it (same kind, or no kind), so the school
is one room of about 135 tiles. Screenshots: `docs/progress/place/kuben-district-*.png`. The same mismatches as for
KKG apply (the first area is still *Glassgata*, an indoor street).

**Tangen bound as well (2026-11-11).** The Tangen example now has `world: "nb-tangen-laerlingplassen"` and the
school as `focus`, like the other two school places.

Map service: the main Overpass server was down for hours on 2026-11-10 (502). `overpass.openstreetmap.fr` answered
from Node and is now the second endpoint, but it refused a request carrying a browser `Origin` header (403), so
browsers may not be able to use it; a server-side proxy with a cache (P4) is the dependable fix.
