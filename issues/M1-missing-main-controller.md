# The playable game did not exist: index.html loaded ./main.ts, which was missing

- Severity: critical
- Area: client integration (src/client/main.ts, src/client/game-controller.ts, src/client/session.ts)
- Status: fixed

## Evidence
`src/client/index.html` loads `<script type="module" src="./main.ts">`, but there was no `src/client/main.ts` and no `game-controller.ts`. Vite logged `Pre-transform error: Failed to load url /main.ts`, the browser got `http 404 http://localhost:5173/main.ts`, and the page only showed the noscript text (docs/archive/progress/M1/playtest-index-unmodified.png is all black). The M1 exit check "play a fixture world in the browser" could not pass. The playtests could only run with a throwaway harness put in place of `/main.ts` through a Playwright route.

## Fix
I wrote the integrator in three layers:
- `src/client/session.ts`: `GameSession` has no DOM. It owns one run: the engine state plus the state the controller adds on top. That covers the look/target cursor and mode, narration (the intro, and the area-enter narration on each transition), dialogue history, the trade panel, the camera step and the click-to-travel destination. It turns UI callbacks into engine actions and returns an `Outcome` for the browser to apply: renderer events, toasts, tooltip data, camera commands and a travel flag. It also builds the full `UiViewModel` with the `view.ts` builders, game or end screen. Behaviour:
  - Movement keys and cursor moves are relative to the screen, so they are turned to match the camera step (`rotateDir`).
  - Talk and persuade target the nearest NPC that the engine's `legalActions` accepts. Persuading from inside the dialogue panel first leaves the conversation, because the engine accepts no other action while a choice is open.
  - Dialogue replies, leaving and trade buys are mapped onto engine option indices through `dialogueMap`. After a buy, the session talks to the trader again so the shop stays open. Buying without enough money gives a warning toast and the shop stays open.
  - An aimed item that is activated without a target, for example from the backpack menu, enters target mode. The cursor starts on the engine's automatic target. A refused target keeps target mode open so the player can pick again.
  - Click-to-travel moves one step per tick. It stops on arrival, when a new hostile comes into view, when the player is attacked or gets a status effect, on low HP, at a level-up or choice, on a pickup, a newly discovered region, a spawn or an area change. Steady background damage, such as fixture-western's heat rule, does not stop it.
  - Clicking the player's own tile picks up or takes the exit. Clicking a visible hostile out of melee range attacks it with a ranged attack.
- `src/client/game-controller.ts`: `GameController` is the browser glue. It connects the Renderer (setWorld, setArea and `sync` with the step events), mouse input (`attachPointer`, wheel zoom), tooltips placed with `tileToScreen`, highlighting of the target/look cursor, the async travel loop (any key press cancels it) and the autosave to localStorage after every change (cleared when the run ends).
- `src/client/main.ts`: `App` is the app shell. The start screen shows the bundled recorded worlds as demos and inspiration cards, the saved run under "Continue", and the settings dialog with the LLM presets. `canGenerate` is false until the M3 world-generation pipeline exists. The shell starts one controller per run, and the end screen's "New world" goes back to the start screen while "Same world again" starts a new seed. URL shortcuts: `?world=<id>&seed=<n>` and `?continue=1`. `window.__anyworld` gives tests a handle, and `body[data-ready]` is set once the scene is up.
- `index.html` now has an inline SVG favicon. Without it, `/favicon.ico` returned 404, which showed up as a console error on every page load.

## Regression tests
- `tests/client/session.test.ts` (17 tests, fixture worlds): view model and intro, camera-relative movement, refused actions, save/resume, end screen, talk/leave/history, persuading from dialogue, trade buy and close (also with no money), look mode, targeting (including use from a menu), click-to-travel (arrival, interruption by a hostile, heat not interrupting, unexplored destination refused), area-transition narration.
- `e2e/play.spec.ts` (Playwright, headed under xvfb): `/` shows the start screen with 3 demo worlds. A demo starts a run, a few keyboard turns pass and the run is autosaved. `?world=fixture-ship` checks that ArrowUp moves the player up the screen at all 4 camera rotations, that click-to-travel moves the player and that the backpack opens and closes. A dialogue opens with `t` and closes with Esc. The end screen's "Same world again" starts a new run. Every test also checks that the console has no errors and no request returns 404. Screenshots: docs/archive/progress/M1/play-*.png.
