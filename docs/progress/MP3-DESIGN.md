# MP3 — Multiplayer client (design)

Date: 2026-10-28. Branch `multi`. Scope: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3 row MP3, with
§1, §2.1 and the owner decisions in §6; builds on [MP2.md](MP2.md) ("Known gaps for MP3") and the
protocol in [MP2-DESIGN.md](MP2-DESIGN.md) §2–§5. The client gets a room mode next to single player:
lobby, the joined player's own view, party UI, chat, notices. The game master in rooms stays the
server's canned director (MP4). **Single player plays exactly as today**: same code path, same saves,
golden replay and new-player gate unchanged, the existing e2e specs pass untouched.

## 1. Where room mode lives

```
App (main.ts) ── screen: start | loading | lobby | game | end
  ├─ single player: GameSession ──────────────┐
  └─ room:  RoomLink (RoomClient + WebSocket)  │
             └─ RoomSession extends GameSession┤── GameController ── Renderer / GameUi / MapOverlay
                                               │      (room: + PartyOverlay, ChatPanel, TurnPill)
```

New code goes under `src/client/room/` (DOM-free unless noted) and `src/client/ui/components/`:

| Path | Content |
|---|---|
| `room/config.ts` | `roomsEndpoint(build)`: `null` (static build without `ANYWORLD_SERVER_URL`) or `{ api, ws }`; `ws` derived from the server URL or `location` (`https:` → `wss:`), path `/api/ws` |
| `room/api.ts` | `listRooms`, `getRoom`, `createRoom`, `uploadWorld`, `health` over an injected `fetch` with a 5 s timeout; results typed `ok \| unavailable \| outdated \| refused(code)`; bodies checked with the protocol's zod schemas |
| `room/profile.ts` | name and colour (`localStorage anyworld.mp.profile`), seat tokens per room code (`anyworld.mp.seats`: `{ code: { token, at } }`, at most 20, pruned after 7 days); every access in try/catch as in `storage.ts` |
| `room/perspective.ts` | `perspective(state, pid)` (§1.3), memoised per state object |
| `room/room-session.ts` | `RoomSession extends GameSession` (§1.2) |
| `room/chat-model.ts` | history, bubbles, typing, emotes, pings, send throttle (§4) |
| `room/link.ts` (DOM) | `RoomLink`: builds the `RoomClient` with `(url) => new WebSocket(url)`, presence from `visibilitychange` and menus, notices → toasts, status → reconnect banner |
| `room/qr.ts` (DOM) | share link → SVG (§2.5) |
| `room/log-overlay.ts` | client-only log lines (the healer's "helps you" line, §1.1) merged into the log view by turn; never written into `state` |
| `party-overlay.ts` (DOM) | name tags, chat bubbles, typing "…", pings, teammate edge arrows; the MapOverlay pattern (re-projected each frame through `renderer.tileToScreen`), with `setAvoid` rectangles for every HUD panel (§4) |
| `ui/components/rooms.ts` | the start page's "Play together" card (room list, create, join by code, profile) |
| `ui/components/lobby.ts` | `LobbyScreen` (roster, ready, world picker, options, share, chat) |
| `ui/components/chat.ts` | `ChatPanel` (side column, input, emote row, ping buttons), the phone chat button and sheet |
| `ui/components/party.ts` | turn pill ("2 of 3 acted"), party strip, exit-countdown banner, spectator pill, reconnect banner |

`src/client/room/*` imports `src/net` (protocol, `RoomClient`, `noticeFor`), never the server. The
view model grows optional fields only (`UiViewModel.lobby`, `GameView.party`, `GameView.chat`); with
them absent every component renders as today.

### 1.1 Lockstep in the browser

`RoomClient` (MP2 C4) already keeps the replica: it applies every `entries` frame with `applyEntry`,
reports hashes, sends `applied` after an area change and reconnects with token and `lastN`.
`RoomSession` never steps the engine for real and **never writes the replica**. Two names:

- `replica` (a getter on `RoomSession`): always `client.state`, the object `RoomClient` hashes. Only
  the dry run, `absorb` and the tests read it.
- `state` (the existing `GameSession` field, a plain field because the target is ES2022 and a
  subclass accessor cannot override it): in a room it is **assigned** `perspective(replica, pid)`
  (§1.3) in `absorb` and on every `state` event, nowhere else. So every existing read of
  `this.state` / `session.state` (view.ts, guide.ts, travel.ts, `legalActions(this.state)` in
  session.ts and game-controller.ts, audio cues) answers for this player without being found one by
  one. The base-class writers (`drainEngineQueue` in the constructor, `afterChange`, `applyGm`,
  `reopenConversation`, `setStateForTest`) are overridden or guarded by `this.replicaMode`; a
  `room-session` test freezes the replica and fails on any write (a setter trap on `state` that only
  `absorb` may pass).

The single-player `afterChange` drains `gmQueue` into a new state object; the room session skips
that, and narration, rules, dialogue history and audio are derived per entry (step 4).

Data flow of one turn:

1. A key, tap or click reaches `GameController` as today → `session.uiAction(a)` → `act(a)`.
2. `RoomSession.act(a)` **dry-runs** `stepTurn(replica, [{ playerId: pid, actions: [a] }], { world })`
   (the raw replica: party order changes engine results, `ctx.pid = party[0]` in `runWorld`) and reads
   this player's `outcome.reason`: `illegal` → the same `explainInvalid` toast as single player and
   nothing is sent; `down` → the down card (§3.4), nothing sent; `not ready` (slowed, energy below
   `ACT_COST`) is **sent** and shown as queued (the server keeps a not-ready player's input pending).
   The dry run is skipped (the action is sent unchecked) for `transition` and when
   `area.exitCountdown.turnsLeft <= 1`, since those steps make the next area on the main thread. Then
   `client.input(actions, intent, busy?)` with `intent` = `travel` while click-to-travel runs, `wait`
   for the wait action, else `decide`. It returns an Outcome with `pending: a` (the HUD marks the
   queued action; a ghost marker on the target tile) and `changed: false`. Controller branches that
   test `out.changed` (the tap-bump fallback, tooltip refresh, travel `more`) treat `pending` as
   "accepted, nothing to redraw yet".
3. Coalescing (input bucket 20/s): one turn input per `state.turn`; a different action for the same
   turn replaces it (the server keeps the latest), the same action again is not resent (key repeat).
   Free actions (talk, choose_option, choose_perk, toggle_sneak) are sent at once; the server appends
   them as `advance: false` entries. **Chains** that single player builds from several `act` calls
   (`dialogueReply` / `reopenConversation`: `[choose_option, talk]`; `trade` buy / sell:
   `[choose_option, talk]`; leave then persuade) go as **one** input of up to `actionsPerInput` (4)
   free actions, resolved in order by the engine, built from the current state only. The reopen
   bookkeeping (history kept, voice line = the answer, `tradeOpen`) happens in `absorb` when that
   entry arrives, keyed by a `pendingChain` record. The reopen's greeting stays in the shared log
   (accepted: the engine is not changed), and the healer's extra "helps you" line goes into the
   client-only `log-overlay`, never into `state`. The local GM-offer `recheckOfferOption` is not used
   in rooms (no local GM).
4. `RoomClient` emits `entries { steps, catchUp }` (a D1 change: `applyAll` records per entry
   `{ entry, before, after, events, outcomes }`; `catchUp` is true for the batch from
   `welcome.entries`) → `RoomLink` → `session.absorb(steps, catchUp)`, which walks the steps (below)
   and returns one Outcome per batch → `controller.apply(out)` (renderer sync, toasts, tooltips) as
   today. A catch-up batch rebuilds without toasts, bubbles or narration cards. The controller syncs
   the renderer **serially** (await each `sync`, bounded by a 1.5 s timeout); with a backlog over 4
   batches, or while `document.hidden`, it syncs the latest state with no animation (the snap never
   depends on animation frames).
5. `state` events (welcome snapshot, desync snapshot, new run) → full rebuild: `renderer.setArea` +
   `sync(state, [])`, narration cleared, travel stopped.
6. `refusal` (to this seat only) → `explainInvalid` toast; `error stale` → drop the pending mark and
   decide again (travel resends its next step).

`RoomSession` is created **synchronously** on `welcome` (or `run`) and absorbs from that moment;
`launch` then awaits `ensureRenderer` (the three.js chunk, slow on phones) and `controller.start`
builds from the session's current state, so entries that arrive while loading are not lost.
`launch` takes a `WorldEntry`; rooms build one from the server's `WorldSpec` (`roomWorldEntry`:
`recordingsKey` and `audio.startRun` read it).

### 1.2 What changes in `GameSession` and `GameController`

`GameSession` (refactor only, single-player behaviour identical, `tests/client/session.test.ts`
unchanged, and a new characterization test written **before** the refactor, §7):

- `playerId` becomes a field (`pid`, default `state.party[0]`), and `me` reads `state.players[pid]`
  (in rooms `state` is the perspective, so `party[0]` is `pid` too).
- `act()` is split into `act(a)` (single player: `step` + `absorbStep`) and `protected absorbStep(before,
  after, events, mine?)` (dialogue history, narration on area change, voice, rules, onboarding count,
  end of run). `applyGm` likewise keeps `applyGmActions` and moves the narration part into
  `protected absorbGm(before, after, events, hook)`.
- `travelTick()` is split into `nextTravelAction(): PlayerAction | null` (the stop rules: destination
  reached, a new hostile in view, a choice open) and the step.
- the chains in `dialogueReply`, `reopenConversation` and `trade` are split into "which actions"
  (`dialogueReplyActions`, `tradeActions`) and "the bookkeeping after them", so single player runs
  them as today and `RoomSession` sends them as one input (§1.1 step 3).

`RoomSession extends GameSession`: constructed from the `welcome` (world, replica, pid); `act` as in
§1.1; `absorb(steps, catchUp)` walks the steps: `turn` → `absorbStep(before, after, events, mine)` with
this pid's outcome as `mine` (and the `pendingChain` bookkeeping); `gm` → `absorbGm(hook)` (intro and
area cards come from the server's GM entries); `join` / `away` / `back` / `leave` / `return` → party
toasts ("Kari joined", "Kari is away", "Kari is back", "Kari left the map") — the **entries are the only toast source** for
these (§3.6 does not toast roster presence again), and catch-up batches give none; after the batch,
if travel is on and `pid` is engine-ready on a new `state.turn`, `nextTravelAction()` is sent with
intent `travel`. It also keeps the clock view, the roster, the followed teammate (§3.4) and the
queued action. No autosave, no `SavedRun`; the single-player autosave is never read, cleared or
written by a room.

`GameController` gets an optional `room?: RoomLink` in `ControllerHost`:

- no `GmRunner` requests (`pumpGm` returns at once; the server is the GM), no NPC voice (`dialogue:
  null`), no autosave, no `setAddress(runUrl)` (the address bar keeps `?room=CODE`);
- the travel loop is entry-driven (above) instead of the 70 ms timer; the window-capture keydown
  handler that stops travel (`onKey → stopTravel`) skips `isTextTarget`, so typing "on my way" in
  chat does not stop a walk;
- the renderer, the MapOverlay's exit-marker fog and the PartyOverlay get `session.cameraState`
  (§1.3) wherever they get `session.state` today (`start`/`setArea`, `apply`, `runTravel`,
  `updateOverlay`); `tapMeaning`, `onTap` and the nearby-tiles code keep `session.state` (the player);
- `presence` is sent on change only: `menu` while the backpack, help, rules, settings, the phone chat
  sheet or **the desktop chat input** is open, or the tab is hidden; `playing` otherwise. So a player
  reading or writing chat never holds up a turn (plan §2.1).

The run lifecycle: on `run` (play again, maybe another world) `RoomSession` and `GameController` are
disposed and relaunched (their `world`, `seed`, `difficulty`, `endedNotified` and `RuleTracker` are
per run); `RoomLink` and `ChatModel` live for the whole room.

`App` (main.ts) gets `openRoom(code)`, `createRoom(opts)`, `leaveRoom()`, the `lobby` screen and the
room callbacks; `launch()` is shared, with the room flavour skipping `clearRun`, `runAi` and autosave.
`InputLayer` and the `UiViewModel` screen union gain `lobby` (`computeLayer` returns the screen).
In a room the in-game menu's "New run" / "Back to start" become **"Leave room"**, with the line "You
leave the party; you get no character in the next run" (`leave` sets `quit`); it never calls
`clearRun` and never touches the single-player save. The end screen in a room hides "New run" and
the single-player run link and shows the room block (§2.6) instead.

### 1.3 The client plays its own player id

The engine already answers per player (`EngineEnv.playerId`; `leadPlayer` / `party[0]` is only the
default), and the client's ~60 lead reads (view.ts, travel.ts, guide.ts, render, audio cues) all go
through `party[0]`. Instead of threading a pid through all of them, the view uses a **perspective**:

```ts
/** the same state with `pid` first in party order: every lead read (view, fog, compass, hints,
 *  persuade odds, legal actions, renderer) then answers for `pid`. Read-only: never stepped,
 *  hashed or sent. Memoised per (state, pid) so identity checks in the renderer still hold. */
export function perspective(state: GameState, pid: PlayerId): GameState;
```

Rotating the party changes no engine result for a read: the only engine uses of `party[0]` are the
default pid, the GM context (server side) and the transition fallback (not reached by reads). A unit
test checks it: for a 3-player state, `legalActions(perspective(s, p2))` equals `legalActions(s, {
playerId: p2 })`, and likewise `playerSheet`, `persuadeOdds`, `transitionBlocker`. Fog, the compass
chevron, interact hints, "talk" / "persuade" odds and the HUD are then per player for free; party of
one: `perspective(s, p1) === s`.

Two perspectives exist in a room: `state` (always this player: HUD, hotbar, choices, hints, §1.1)
and `cameraState` (this player, or the followed teammate while down, §3.4) for the renderer and the
PartyOverlay (fog, camera follow, sight radius). The engine's raw party order (the replica) is used
only by the dry run and the hashes.

The renderer cannot switch perspectives by state alone: `ActorLayer.ensure(a, isPlayer)` fixes
`isPlayer` per actor view, and visibility, see-through, ring opacity, HP-bar skipping and ghosting
(`leadPlayer(state).sneaking`) follow it. A new optional `renderer.setFollow(actorId)` re-flags the
views (feature-detected; single player never calls it); the controller calls it whenever
`cameraState`'s lead changes.

## 2. Start page and lobby

### 2.1 Availability

`roomsEndpoint` decides once at boot: the backend build → same origin; a static build with
`ANYWORLD_SERVER_URL` → that server; a static build without it (GitHub Pages demo) → `null`: no
"Play together" card at all, and a `?room=` link opens the start page with the toast
`room.noServer`. With an endpoint, the start page calls `GET /api/health` and `GET /api/rooms`:

| Result | Card shows |
|---|---|
| ok | open rooms (newest first), Create, Join by code; refreshed every 15 s while the start page is visible and on a ↻ button (limit 60/min per IP) |
| fetch error, timeout, 5xx | "Rooms are unavailable right now (the game server is offline)" + Retry; Create and Join disabled; single player untouched |
| `health.engine !== ENGINE_VERSION` (not `'dev'`) | "A new version is out" + Reload (the toast's text `net.outdated`) |

A room row: world title and genre, players `3/8`, phase (`lobby.phase.lobby` "Waiting" /
`.playing` "Playing" / `.ended` "Finished"), Join (disabled unless `joinable`), and "Rejoin" when a
seat token for that code is stored.

### 2.2 Create

One tap from the start page: each demo world card (and each of "Your worlds", which is uploaded)
gets a **"Play with friends"** button, and the "Play together" card a "Create a room" button (the
selected world). It creates the room with the default options (max players 8, turn deadline 2 s, the
start screen's difficulty; all editable by the host in the lobby). The only question is the name,
asked once in a small sheet when no profile is stored (name prefilled `lobby.defaultName` + a number,
colour = a random `PLAYER_COLOURS` entry, both kept in the profile). `POST /api/rooms { engine, demo |
world, options }` → `{ code, token }`; the token is stored for the code and the client connects **at
once** (`hello { token, name, colour }` from the profile, so the creator is host: MP2 gap "connect
the creator first"); address bar `?room=CODE`. Errors: 409 → `net.outdated` with Reload; 503 →
`net.serverFull`; 400 invalid world → `room.worldInvalid` with the first error; 429 →
`room.tooMany`.

### 2.3 Join

- **Link** `?room=K7QX`: `bootRoute` gets `{ kind: 'room', code }` (a valid `Code` after upper-casing;
  it wins over `?world=`; the saved single-player run is never touched). `GET /api/rooms/:code` → 404
  → start page with `net.noRoom`. With a stored token → connect straight away (a reload rejoins the
  same seat). Without one but with a stored profile → connect straight away with it. Only the very
  first time (no profile) the join step asks for a name (the same small sheet as §2.2).
- **Code**: a 4-character field on the card (upper-cased, the code alphabet only, Enter submits).
- **Name and colour as given**: the server quietly changes a clash (`uniqueName` adds a suffix,
  `uniqueColour` takes the next free one). After `welcome` the client compares its roster entry with
  what it asked for; when they differ a short toast says "You are Kari 2, green" (`lobby.youAre`)
  with a "Change" action that opens the profile sheet (`profile` message). No colour dimming before
  `hello` (there is no roster to dim from).
- **By phase of the welcome**: `lobby` → the lobby screen; `playing` → straight to `screen: 'game'`
  (late join: the server already pushed the `join` entry and the welcome carries the pid and the
  replica, so `RoomSession` is built from them, §1.1); `ended` → the end screen with the room block
  (§2.6), waiting for the next run. No lobby step in between.
- `bad_token` → the token is dropped and the client joins as new (`client.token = undefined;
  client.connect()`, same name and colour; toast `net.badToken`).

### 2.4 Lobby screen (`screen: 'lobby'`)

```ts
interface LobbyView {
  code: string; link: string; qr: string | null;          // SVG markup, lazily made
  world: { title: string; genre: string; tagline: string; color?: string };
  phase: Phase; you: { seat: string; host: boolean; ready: boolean };
  roster: { seat: string; name: string; colour: string; host: boolean; ready: boolean;
            presence: SeatPresence; you: boolean }[];
  options: RoomOptions; maxPlayers: number;
  host?: { worlds: DemoWorldView[]; own: RecentWorldView[]; canStart: boolean };
  chat: ChatView;                                           // chat works in the lobby too
  joining?: { name: string; colour: string }               // the first-time name sheet
}
```

`world.tagline` and `color` come from the client's demo catalogue by demo id (`RoomInfo` carries only
title and genre), so a `world` change shows the full card before the run starts.

Top to bottom: the code in large type with Copy link / Share (`navigator.share` on phones, else the
clipboard with `room.linkCopied`) and the QR code; the world card (host: "Change world"); the roster
(colour dot, name, "host", ready tick, presence: away / off); options (host: editable, others: read
only); **the GM line** `lobby.gmReadsChat`: "The game master reads the chat; chat lines are sent to
the AI provider." — worded for MP4 on the owner's request: in MP3 the canned director reads nothing
and nothing is sent to an AI provider, so the line becomes accurate with the AI GM (MP3.md says so);
Ready toggle; host: Start ("2 of 3 ready" beside it, never required: the host can start any time,
fast first); Leave; the chat panel. Your own roster row has "Change" → the profile sheet (name and
the 12 `PLAYER_COLOURS` as swatches; colours other seats hold are dimmed there, from the roster).
Names are rendered with `textContent`, as chat lines are.

### 2.5 Share link and QR code

The link is the **page's** origin, not the server's: `${location.origin}${location.pathname}?room=CODE`
(on Pages `https://any.dv8.no/?room=K7QX`). QR: the `qrcode-generator` package (kazuhikoarase, MIT,
no dependencies, 1.4.4 pinned exactly like the others, ~20 KB), imported lazily by the lobby so it is
not in the start bundle; `room/qr.ts` turns its module matrix (`getModuleCount`, `isDark`) into one
SVG `<path>` (error correction M, 4-module quiet zone, dark on white also in dark themes). A unit test
checks the matrix size and the three finder patterns for a known link. No hand-written fallback
encoder; if the package truly cannot be installed the lobby shows the link only and MP3.md says so.

### 2.6 Play again

When the replica's `status` is `won` / `lost` the end screen gets a room block: host → "Play again"
(same world, `start`) and "Choose another world" (back to the lobby screen's world picker; a demo via
the new `world` message, an own world via `POST /api/rooms/:code/world`); everyone → Ready toggle,
"Leave room". The `run` message brings everyone into the new run (session and controller
relaunched, §1.2). "Play again" sends `start` without `demo`; the world is chosen beforehand with
`world` (below).

### 2.7 Protocol and server additions (small; part of step D1)

MP2 left four lobby needs uncovered. They change `src/net/protocol.ts`, so the engine version changes
(expected; old pages get the reload toast):

| Message | Fields | Server |
|---|---|---|
| `ready` (c→s) | `on` | lobby / ended; `RosterEntry.ready` (reset at a run start); roster broadcast |
| `profile` (c→s) | `name`, `colour` | lobby / ended; same uniqueness rules as `hello`; roster broadcast |
| `world` (c→s) | `demo` | host, lobby / ended: the room's (next) world; `room` broadcast |
| `options` (c→s) | + `difficulty?` | difficulty in lobby / ended only |
| `ping` (c→s) | `kind: 'follow' \| 'wait' \| 'help'`, `x`, `y` | playing; chat bucket (1/s); a `ChatLine` with `ping: { kind, x, y, area }` and `text: ''` (history, broadcast, GM-readable in MP4) |
| `room` (s→c) | `room: RoomInfo`, `options` | on any world or options change |

`world` is the canonical way to pick a demo (the lobby shows the pick to everyone); `start { demo }`
stays accepted by the server for the MP2 scripted clients and bots, but the client never sends it.

Two server fixes found in review: **typing keeps busy** — `stopTyping` clears busy only if
`startTyping` set it (the seat was not already busy from a dialogue, trade or menu), so typing during
a dialogue does not end its safety; and the welcome of a `playing` room (late join) is covered by a
`rooms-room` case.

`RoomClient` keeps `room`, `options`, `typing` (seats typing), `clock` (last frame) and adds
`ready(on)`, `profile(name, colour)`, `world(demo)`, `ping(kind, pos)`, `setOptions(...)`; `applyAll`
emits per-entry `steps` and a `catchUp` flag (§1.1 step 4); it records the close code as
`stopReason` and puts it in the `stopped` status event (4007 → `room.otherTab`, 1008 → the notice
of a policy close, apart from a plain `leave()`). Tests: new cases in `rooms-room`, `protocol` and
`net-client`.

Test-only switches (read only when set, ignored in production like `ANYWORLD_TEST_TIMING` in
`server/index.ts` / `dev.ts`): `ANYWORLD_TEST_SEED` (wired through the existing `RoomDeps.seed`) for
fixed run seeds, and `ANYWORLD_TEST_LIMITS` (JSON, through `startServer({ rooms: { limits } })`), so
the browser specs, all on 127.0.0.1, do not hit `createsPer10Min` 6, `upgradesPerMin` 20,
`socketsPerIp` 16 or the room cap.

## 3. In game

### 3.1 Other players

- **Colour**: the existing faction ring under every player actor (`ringMat`) is recoloured to its
  seat colour (own included; no second ring), from `renderer.setPartyColours(Map<actorId, colour>)`
  (a new optional renderer method, feature-detected like `itemThumbnail`; single player never calls
  it). The seat → pid → actorId map comes from the
  roster and the replica.
- **Name tags**: PartyOverlay DOM labels above other players' actors on visible tiles (`cameraState`
  fog = 2), in the seat colour with a dark outline, text set with `textContent`; dimmed with "away" for `off` / `idle` seats, and a
  "busy" glyph while they are in a dialogue, trade or menu. Own name is not tagged.
- **Teammates off screen**: a small coloured edge arrow with the name (`edgeArrow` /
  `placeEdgeMarker` from map-overlay.ts, clear of the HUD), so a party can find each other.
- **Party strip** (top bar, desktop; on phones a row of dots plus "2/3" in the portrait grid's
  `strip` row, in place of the turn counter): one chip per party member: colour, name, hp bar, state
  (acted ✓, "Kari: deciding", busy, away, down). While down, tapping a chip follows that teammate.
  (Tap-to-centre for 2 s while standing is optional, not part of MP3's exit check.)

### 3.2 Turn indicator, never blocking

From the `clock` message (`acted`, `waiting`, `deadlineInMs`): a pill under the top bar, shown only
when this player is in a party of 2+ and some active player has not acted **for 450 ms** (and hidden
250 ms after the turn resolves), so normal walking, where turns resolve in 100–600 ms, does not
flicker it: "2 of 3 acted" and a thin bar draining over `deadlineInMs`. After this player acted it
reads "Kari is deciding" (never "waiting for") for at most the deadline; keys and taps still work (the new input replaces the queued one, the server keeps the
latest). Nothing in the client ever waits on the clock: no modal, no input lock. Phones: "2/3" with
the bar, no names (in the `strip` row, §3.1). i18n: `party.acted` (`{acted} of {total} acted`),
`party.deciding` (`{name} is deciding`).

### 3.3 Per-player view

Fog, the exit marker and compass, interact hints, ranged targets, `persuadeOdds` in the dialogue and
the HUD all come from `state`, the perspective (§1.1, §1.3), so they are this player's. Log lines stay the shared engine log
(it names who did what). The narration card for an area appears for everyone (the server's GM entry);
the GM's own fog is still the lead's (MP4). Plan §2.1's "other players near the speaker see the NPC's
lines as bubbles" is **deferred to MP4**: the canned director's NPC lines are not in the entries'
outcomes, and MP4's AI dialogue is where they come from (listed in MP3.md).

### 3.4 Down players and the spectator camera

`me.down` set → the renderer and PartyOverlay switch to `cameraState = perspective(state, followed)`:
the nearest standing teammate by straight distance, kept until they go down or leave; `[` / `]` or
the `‹ ›` buttons on the spectator pill ("Watching Kari") cycle (`Tab` stays the backpack; the key
help lists `[` `]` in rooms). The controller calls `renderer.setFollow` on every switch (§1.3). The HUD stays this player's, with a card "You are down. You
get up in {n} turns, or sooner when a teammate stands next to you" (`n` = `REVIVE_SELF_TURNS` −
(`turn` − `down.since`), exported from the engine index if it is not yet), the hotbar dimmed, chat,
emotes and pings working. Getting up → camera back with a short tween. A teammate who is down gets a
pulsing "help" ring under them on every screen (they need someone next to them).

### 3.5 Exit countdown

`state.area.exitCountdown { turnsLeft, by }` → a banner over the top bar on every screen: "Kari took
the exit: the party moves on in {n}" (`party.exitCountdown`), ticking with each turn (the server
paces them at ~1 s, so turns read as seconds). The player who took it sees "The party moves on in
{n}" (`party.exitTaken`). No button, nobody waits at the door; the area change rebuilds as today.

### 3.6 Away and left teammates, reconnect

Roster `presence` `off` → name tag and chip dimmed "away" (no toast here: the toasts come from the
`away` / `leave` / `back` / `return` entries only, §1.2); `gone` (2-minute rule, `leave` entry) → chip
greyed "left". This client's own
connection: `RoomClient` status `reconnecting` → a non-blocking banner "Reconnecting…" (input queued
nowhere: `act` toasts `room.offline` while not joined); after 20 s it adds "Leave room". On reconnect
`ChatModel` merges the welcome's chat by `ChatLine.id` (no repeated bubbles or unread counts).

**Phone layout** (portrait grid, `ui.css`: hud, strip, goal, banner, map, log + tools, ctx, slots):
nothing floats. The chat button with its unread badge goes in the `tools` row next to backpack,
rules and help (the log ticker narrows to ~190 px); off-screen chat lines show in the existing log
ticker (no second ticker); the party dots and "2/3" in `strip`; exit countdown, spectator pill and
reconnect banner share the one `banner` area, priority reconnect > down/spectator > exit countdown.
The chat sheet joins `panelRects` for `coverInsets`, and the PartyOverlay avoids every HUD panel. `joined`
again → banner gone, state rebuilt from the `welcome` (entries or snapshot).

## 4. Chat UI

`ChatModel` (DOM-free, `room/chat-model.ts`):

```ts
class ChatModel {
  lines: ChatLine[];                       // ≤ LIMITS.chatHistory (100), from welcome + chat frames
  typing: Set<string>;                     // seats typing (typing frames; cleared on their next line or after 8 s)
  unread: number;                          // phones: lines since the sheet was last open
  push(line, now): void; bubbles(now): Bubble[];      // one per speaker, the newest line
  canSend(now): { ok: true } | { ok: false; waitMs: number };   // 1/s, mirrors the server bucket
  draft(text): { left: number; over: boolean };       // LIMITS.chatMax code points (codePoints)
}
interface Bubble { seat: string; text: string; emote: boolean; ping?: PingKind; until: number }
```

- **Bubbles or column.** For each new line the PartyOverlay asks "is the speaker on screen?": their
  actor is on a visible tile of `cameraState` and projects inside the viewport outside the HUD rects.
  Yes → a speech bubble over them (max 3 lines, wraps at ~28 characters, `4 s + 50 ms × characters`,
  capped at 10 s; a newer line replaces it). No (or the speaker is this player in the lobby, or not on
  the map) → the line is highlighted in the side column. The side column always lists the history:
  colour dot, name in colour, text; own lines right-aligned.
- **Desktop**: the ChatPanel docks on the right under the rules panel (≈ 280 px, the last 6 lines,
  fading after 20 s unless hovered or the input is open; scroll for the 100). **Enter** (in the
  `game` layer of a room) opens the input; Enter sends, Esc closes, an empty Enter closes. In rooms
  "use next to you" moves from Enter to Shift+Enter (bump and click still use; room variants of
  `tile.usableHint`, `ctx.interactHint` and the key-help line say so). **`/` opens the input in every
  non-text layer** (dialogue, trade, choice, narration, look, target, backpack), where Enter keeps its
  meaning (confirm, skip a narration card); the input is also clickable in every layer. Chatting in a
  dialogue or trade keeps that seat busy (the server fix in §2.7).
- **Keys inside the input**: its own keydown handler takes Enter and Esc and calls `preventDefault`
  and `stopPropagation`, so Esc closes only the chat, not the backpack or rules behind it. Sending goes
  through a `<form>` submit with `enterkeyhint="send"`, and nothing is sent while
  `isComposing` / key code 229 (Android IME).
- **Phones**: an always-visible chat button with an unread badge in the `tools` row (§3.6) opens a
  bottom sheet: history, input, the emote row and ping buttons; off-screen lines also show for 4 s
  in the existing log ticker. The sheet uses `interactive-widget=resizes-content`
  (already set), so the keyboard pushes the sheet, not the map.
- **Keyboard focus**: the input is a real `<input>`, so `isTextTarget` puts every key into the `text`
  layer (no game key fires; `tests/client/input.test.ts` gets the room cases). Closing the input
  returns focus to the canvas host. Typing never sends an `input` (it costs no turn).
- **Typing state**: on the first non-empty `input` event `client.typing(true)`, repeated every 3 s
  while the text changes; `typing(false)` on send, on clearing the field, on blur and on closing.
  Others see a "…" bubble over the typist (or "Kari is typing…" at the foot of the column). Presence
  is `menu` the whole time the input or sheet is open, typed in or not (§1.2), so a reader never
  holds up turns.
- **Emotes**: six one-tap buttons 👍 😂 😮 ❤️ 👋 ❓ send that emoji as the chat text; a line that is
  exactly one emote renders as a large bubble without a frame. **Pings**: "Follow me", "Wait", "Help"
  send `ping` at the player's own position (one tap, which is what they mean); everyone sees a
  coloured marker with an icon there for 8 s (edge arrow when off screen) and a column line "Kari:
  Follow me" (`ping.follow`, `ping.wait`, `ping.help`).
- **Limits and feedback**: the counter shows from 160 code points, the field stops at 200
  (`maxlength` by code points in the input handler, counted with the protocol's `codePoints`, as
  `cleanChat` does: ❤️ is two); text, emotes and pings share the 1/s chat bucket, so a send within
  1 s of the last (an emote right after a ping included) shows "Wait a moment" (`chat.slowDown`) under
  the input **and on the emote and ping row**, and keeps the draft; `error chat_rate` / `chat_long` from
  the server do the same (never a toast). Lines are rendered as text (`textContent`), never HTML.

## 5. Notices and errors

| Source | Shown as |
|---|---|
| `notice` with `reload` (`net.outdated`) | sticky toast with a **Reload** button (`net.reload`), never an automatic reload; the room view stays, input off |
| `notice` `net.serverUpdated`, `net.roomClosed`, `net.closedIdle`, `net.closedEmpty`, `net.closedError`, `net.noRoom`, `net.roomFull`, `net.serverFull` | back to the start page with that toast (the warn tone); the stored token for the code is dropped (except `room_full`) |
| `net.badToken` | info toast; the token is dropped and the client joins as new |
| `fault world_mismatch / world_invalid` | start page, toast `room.worldMismatch` |
| `error not_host / bad_phase / invalid` | warn toast `room.notAllowed` (a UI bug or a race; logged) |
| `error rate`, `stale` | nothing visible (logged; stale re-decides) |
| status `reconnecting` / `joined` | the banner of §3.6 |
| close 4007 (replaced: another tab), from the `stopped` status's `stopReason` | start page, toast `room.otherTab` |
| close 1008 (policy) | start page, toast `room.notAllowed` |

`GameUi.toast(text, tone, action?: { label, run, sticky? })` gains the optional action; ToastStack
keeps a sticky entry until its button or ✕ is pressed; a sticky entry does not count toward `max`
(3) and is never dropped as the oldest. A test checks that every `NET_NOTICE_KEYS` key
and every new `room.*`, `lobby.*`, `chat.*`, `party.*`, `ping.*` key exists in en and nb with the same
params (the existing i18n test covers this once the keys are in `en.ts`).

New keys (en and nb, about 70): `room.title`, `.create`, `.joinCode`, `.join`, `.rejoin`, `.refresh`,
`.unavailable`, `.noServer`, `.outdatedPage`, `.empty`, `.players`, `.worldInvalid`, `.tooMany`,
`.linkCopied`, `.share`, `.copyLink`, `.leave`, `.offline`, `.reconnecting`, `.otherTab`,
`.worldMismatch`, `.notAllowed`; `lobby.code`, `.phase.*`, `.ready`, `.notReady`, `.readyCount`,
`.start`, `.host`, `.changeWorld`, `.options.*`, `.gmReadsChat`, `.name`, `.colour`, `.defaultName`,
`.joinAs`, `.youAre`, `.change`, `.playWithFriends`, `.playAgain`, `.anotherWorld`, `.waitingHost`;
`room.leaveRun`, `.leaveRunHint`; `party.acted`, `.deciding`, `.joined`, `.away`, `.back`, `.left`,
`.down`, `.watching`, `.exitCountdown`, `.exitTaken`, `.busy`;
`chat.open`, `.placeholder`, `.send`, `.typing`, `.slowDown`, `.left`, `.emotes`, `.history`;
`ping.follow`, `.wait`, `.help`; `keys.chat`, `keys.cycleFollow`, room variants
`tile.usableHintRoom`, `ctx.interactHintRoom`.

## 6. Pages build

| Build | Rooms |
|---|---|
| `npm run build` (served by the server) | same origin: `/api/rooms`, `wss://<host>/api/ws` |
| static, `ANYWORLD_SERVER_URL=https://any-game.dv8.no` | `https://any-game.dv8.no/api/...`, `wss://any-game.dv8.no/api/ws` (Origin checked against `ALLOWED_ORIGINS`); share links point at the Pages origin; server offline → "unavailable" (§2.1) |
| static without it (the offline demo) | no rooms card, `?room=` → start page + `room.noServer`; nothing fetched, no `ws` code path runs; the bundle still contains the room chunk lazily (the lobby, chat and QR are dynamic imports so the start bundle grows by the card only) |

`room/config.ts` reads the same build constants as `main.ts` (`__ANYWORLD_SERVER__`,
`__ANYWORLD_DEFAULT_TRANSPORT__`); `tests/client/room-config.test.ts` covers the three rows.

## 7. Tests

**Unit (vitest, node).** A shared harness `tests/client/room-harness.ts` connects real
`server/rooms/Room` instances (manual `Scheduler`, test timing, fixed seed) to real `RoomClient`s
through an in-memory socket pair (the `Conn` interface on one side, `RoomSocket` on the other, frames
passed as JSON strings, delivered on `queueMicrotask`), so tests run the true protocol without ports.

| File | Checks |
|---|---|
| `room-perspective.test.ts` | perspective equals `{ playerId }` for legal actions, sheet, odds, blocker; identity for a party of one; memoised |
| `room-session.test.ts` | 3 sessions in one room: each plays its own pid (p2 moves p2, not the lead); a full `RoomSession` as p2 has p2's HUD, hints, persuade odds and legal actions; the replica is never written (a write trap on `state`; every client's `hashState` equals the server's after 200 entries); dry run: `illegal` not sent and toasts, `not ready` sent and queued, skipped on the last countdown turn; coalescing (one input per turn, latest wins); chains: "Ask what they know", a healer's help and a shop buy keep the conversation open, sent as one input, the healer line only in the log overlay; travel sends `travel` intents per new turn and stops on a hostile; dialogue history from per-entry steps; GM entries give intro and area cards; join / away / back toasts once each, none for a catch-up batch; late join from a `playing` welcome; down → nearest teammate followed, `[`/`]` cycle, back on revive; exit countdown view; reconnect → state rebuilt, chat merged by id, no duplicate toasts or bubbles |
| `session.test.ts` (existing) | unchanged and passing: the refactor keeps single player identical |
| `session-characterization.test.ts` (new, written **before** the refactor) | a sim bot plays 6 single-player seeds through `uiAction` (dialogue, trade, travel included) and records per step the toasts, narration cards, dialogue history, voice requests, onboarding counts and log; the recording is committed and must stay byte-identical through D2 |
| `chat-model.test.ts` | 100-line cap, merge by id, bubble per speaker and lifetime, emote detection, ping lines, typing set and expiry, 1/s throttle with `waitMs` shared by text, emotes and pings, the client count equals the protocol's `codePoints` (❤️ is 2) |
| `room-api.test.ts`, `room-config.test.ts`, `room-profile.test.ts` | ok / unavailable / timeout / outdated / refused results, endpoint per build, ws URL from http(s), token store prune and drop rules, profile defaults |
| `boot.test.ts` (existing + cases) | `?room=k7qx` → room `K7QX`; an invalid code → start; room wins over `?world=`; saved run kept |
| `input.test.ts` (existing + cases) | room `game` layer: Enter → chat, Shift+Enter → interact, `/` → chat, `[`/`]` cycle while down, Tab still the backpack; `/` → chat in the dialogue, choice, narration, look and target layers, Enter unchanged there; `text` layer: WASD, digits, Space give no command; the `lobby` layer |
| `room-qr.test.ts` | matrix size and finder patterns for a known link |
| `tests/server/rooms-room.test.ts`, `protocol.test.ts`, `net-client.test.ts` (+ cases) | `ready`, `profile`, `world`, difficulty option, `ping`, `room` broadcast; typing during a dialogue keeps busy; late-join welcome; per-entry `steps` and `catchUp`; `stopReason` 4007; test limits and seed read only when set (§2.7) |

**Browser (Playwright, headed Chromium under xvfb).** All room specs live in `e2e-mp/` (outside the
default config's recursive `testDir: 'e2e'`, so `npm run e2e` never runs them against 5173) and
share one config `e2e-mp/playwright.mp.config.ts`: its own ports (5183 / 8797, so the other specs'
dev server and other agents are not touched), `ANYWORLD_DATA_DIR=.data/e2e-mp-<run>` (removed in
global teardown), `ANYWORLD_TEST_TIMING` (deadline 600 ms, travel 30 ms, countdown turn 150 ms),
`ANYWORLD_TEST_SEED`, `ANYWORLD_TEST_LIMITS` (creates, upgrades, sockets per IP and the room cap
raised), `workers: 1`, and the Chromium flags `--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding`, `--disable-background-timer-throttling` (three overlapping
windows under xvfb would otherwise be throttled or report `hidden`, which sends `presence: menu`). Pages start with an init script setting `quality: 'low'` and `reduceMotion: true` in
the settings. Tests wait on conditions through the automation handle (`window.__anyworld.room`:
`state()`, `pid`, `hash()`, `n`, `chat()`, `bubbles()`) with `expect.poll`, never on fixed sleeps,
and compare hashes after waiting until all pages report the same `n`.

- **`e2e-mp/mp-exit.spec.ts` (the exit check)**: three contexts in one browser: A desktop 1280×800
  (host), B desktop 1280×800, C phone 390×844 (`isMobile`, `hasTouch`). A creates a room on
  `fixture-western` from the start page, reads the code and link in the lobby (and the QR SVG is
  there); B opens the link, picks a name and colour; C types the code on the start page. All three
  ready; A starts. Then: A moves with the keyboard, C with taps, B clicks to travel; the turn pill
  shows on B while A acts and A's turns resolve without B; A presses Enter and types "hello" (WASD
  inside the text does not move A), B sees A's bubble (or the column line) and the "…" before it;
  C opens the chat sheet, sends 👍 and a "Follow me" ping, A and B see them. The run is then played
  to its end by the in-page bot (`__anyworld.room.autoplay(true)`: a sim bot from `src/engine/sim`
  choosing through `session.act`, so every action takes the real UI → protocol path; dev and test
  builds only), with a chat line every ~40 entries; the exit countdown banner is seen on all three at
  the first exit; after each area change the three hashes agree; the end screen shows "Play again"
  on all three; A plays again and all three are in the new run's first area. About 3–5 minutes.
- **`mp-lobby.spec.ts`**: room list ("Play with friends" on a card creates, the room appears, Join),
  join by link and by code, a name clash → the "You are Kari 2" toast and Change, ready count, host
  start, a third player opens the link **mid-run** and lands in the game with a character, host
  leaves → B becomes host and starts, server down (`page.route` fails `/api/rooms`) → "unavailable"
  and single player still starts, outdated health → Reload, `?room=ZZZZ` → `net.noRoom`, reload in a
  room → same seat, "Leave room" from the in-game menu → start page with the single-player save
  untouched.
- **`mp-chat.spec.ts`**: one browser page plus two `ScriptedClient` teammates (tools/rooms) to save
  browsers: Enter, bubble on screen vs column off screen, typing bubble, emotes, pings, rate feedback,
  200-character stop, phone button and sheet (phone context), keys never move while typing, chat
  opened with `/` during a dialogue keeps the dialogue open, Esc in chat leaves the backpack open; and
  a 390×844 room-mode overlap check (as `render-phone-panels`) with the chat sheet open and with the
  keyboard up.
- **`mp-party.spec.ts`**: one page plus scripted teammates: name tags and colour rings, party strip,
  turn indicator with an idle teammate (no wait after it goes idle), teammate away and back (the bot
  drops its socket), the exit countdown banner, and the spectator pill when the page's player is
  down: a Hard room (no second chance) with the fixed test seed; the scripted teammates stay in
  `menu` presence (busy, so no hostile picks them) and out of reach while the page's player waits by
  the first hostile, which makes that player the only target whatever the wall-clock timing; once it
  is down, one teammate walks over and revives it. The check is only "the spectator pill appears and
  the camera follows the teammate, then returns"; the bounded overall wait is 90 s. No test-only
  "make me down" call. The order of events and the spectator rules are unit-tested in
  `room-session`.
- the existing specs (`play`, `modes`, `mobile`…) run unchanged against `playwright.config.ts`.

Reliability: fixed seeds and test timing; one browser with three contexts (three WebGL contexts in
SwiftShader are fine at low quality); no assertions on animation frames, only on state through the
handle and on DOM text; every wait bounded; the server and data dir torn down by the config. Suite
budget for `e2e-mp/`: 10–15 minutes; it runs in D3–D5 only, not at every step.

## 8. Build plan

Each step ends with `npx tsc --noEmit -p .` clean, its focused tests, the full `npx vitest run`
passing, the golden replay unchanged, single-player e2e smoke (`e2e/play.spec.ts e2e/modes.spec.ts`)
passing, and a commit on `multi`. The engine is not changed (only `REVIVE_SELF_TURNS` may be
re-exported), so the new-player gate is run once at the end as a check.

| Step | Content | Focused tests |
|---|---|---|
| D1 | **Net additions and client plumbing (no UI)**: protocol and server for `ready`, `profile`, `world`, difficulty option, `ping`, `room`; the typing-keeps-busy fix; `ANYWORLD_TEST_SEED` and `ANYWORLD_TEST_LIMITS` (§2.7); `RoomClient` additions (per-entry `steps`, `catchUp`, `stopReason`); `room/config.ts`, `api.ts`, `profile.ts`; `bootRoute` `room` kind (main.ts treats it as the start page until D3); `qrcode-generator` dependency and `room/qr.ts`; en/nb keys for D1–D4 | `rooms-room`, `protocol`, `net-client` cases, `room-api`, `room-config`, `room-profile`, `boot`, `room-qr`, `i18n` |
| D2 | **Room session core (DOM-free)**: first the single-player characterization recording (committed before any refactor); then `perspective`, the `GameSession` refactor (§1.2: `pid`, `absorbStep`, `absorbGm`, `nextTravelAction`, chain actions split from bookkeeping), `RoomSession` (state = perspective by assignment, guarded writers, dry run, coalescing, one-input chains, `log-overlay`, per-entry absorb, late join), `ChatModel`, the in-memory room harness | `session-characterization` byte-identical, `room-perspective`, `room-session`, `chat-model`; `session.test.ts` and all client tests unchanged |
| D3 | **Controller room mode, start page, lobby, notices**: `RoomLink`, `ControllerHost.room` (serial sync with timeout and hidden snap, entry-driven travel, presence incl. chat input, `cameraState`, travel-stop skips text targets), run lifecycle (relaunch on `run`, synchronous session on `welcome`), `roomWorldEntry`; the "Play together" card and "Play with friends" buttons, name sheet, `LobbyScreen` (roster, ready, world picker, options, GM line, share link, QR, profile change), welcome by phase (lobby / late join / ended), `App.openRoom/createRoom/leaveRoom`, the `lobby` screen and layer, in-game "Leave room", end-screen room block and play again, toasts with actions (sticky exempt from max), reconnect banner; the `e2e-mp/` config; the automation handle `__anyworld.room` | `input` cases, `e2e-mp/mp-lobby.spec.ts`, single-player e2e smoke |
| D4 | **In-game party and chat UI**: ring recolour (`setPartyColours`), `renderer.setFollow`, PartyOverlay (name tags, bubbles, typing, pings, teammate arrows, avoid rects), party strip, turn pill (show/hide delays), banner area with priority, spectator camera and pill (`[`/`]`), away / left; ChatPanel, phone chat button in the `tools` row and sheet, log-ticker chat lines, emotes, pings, Enter / `/` in every layer / Shift+Enter with room hints, focus and IME rules, rate feedback on input and emote row | `e2e-mp/mp-chat.spec.ts` (with the phone overlap check), `e2e-mp/mp-party.spec.ts`, render unit tests for ring and follow |
| D5 | **Exit check and notes**: in-page autoplay (dev/test builds), `e2e-mp/mp-exit.spec.ts` (3 contexts), fixes it finds; `docs/progress/MP3.md` (deferred: NPC-line bubbles for nearby players, the GM line accurate from MP4), plan status; the full gate (typecheck, vitest, golden replay, `--gate --seeds 40`, single-player e2e smoke, all `e2e-mp` specs) | `mp-exit` |

## D1 as built

- **Protocol** (`src/net/protocol.ts`): `ready { on }`, `profile { name, colour }`, `world { demo }`,
  `ping { kind, x, y }` (`PingKind` follow / wait / help), `options` + `difficulty?`; server → client
  `room { room, options }`. `RosterEntry.ready` is **required**; `ChatLine.ping?` is
  `{ kind, x, y, area }` with `text: ''`. New buckets `profile`, `world` (1/s, burst 3) and `ready`
  (4/s); `LIMITS.rateShares.ping = 'chat'`, so `ConnBuckets` takes a ping from the chat bucket.
  Types `RoomMsg`, `ClockMsg` exported. The engine version changes (expected).
- **Server** (`server/rooms/room.ts`): `ready` and `profile` in lobby / ended only (`bad_phase`
  while playing; profile uses `uniqueName` / `uniqueColour`, persisted as a seat record; the
  character keeps its name for the run, the next run takes the new one); `ready` is not persisted
  (a server restart clears it) and resets at every run start. `world` (host, lobby / ended) and the
  HTTP upload share `setWorld`: lobby → the room's world at once; ended → staged as `nextWorld`
  (picking the world just played clears the stage). `info()` reports the staged world in the ended
  phase (also in the public list), so `room.world.id` can differ from `welcome.worldId` (the
  replica's world) after a run. `room` is broadcast on every world or options change (also the
  upload). Difficulty changes are `bad_phase` while playing (deadline and max players still may).
  `ping`: playing only, tile inside the area map (`invalid` otherwise), the same `lastChatAt` 1/s as
  chat (`chat_rate`); the line is kept in history and the room log like chat. Typing busy:
  `Seat.typingBusy` records that typing set busy; `stopTyping` clears busy only then; a client
  `busy: true` input while typing hands busy to the client; a client clearing busy (or a free
  action ending a dialogue) while typing makes typing hold it again (`typingHoldsBusy`, also used
  after a resolve, within `BUSY_MAX_TURNS` of the typing start).
- **Test switches** (`server/index.ts`): `testSeed(env)` (`ANYWORLD_TEST_SEED`: the first run
  seed, each later run the next integer), `testLimits(env)` (`ANYWORLD_TEST_LIMITS`: JSON of
  `RoomLimits` plus an optional `maxRooms`), `testRoomOptions(env)` combining them with
  `ANYWORLD_TEST_TIMING` into `RoomsOptions` fields; `main()` and `dev.ts` spread it into `rooms`.
  All three return nothing when unset or with `NODE_ENV=production`. `RoomsOptions.seed` reaches
  `RoomDeps.seed` through the manager.
- **RoomClient** (`src/net/client.ts`): fields `room`, `typingSeats` (a `Set` of seat ids: named
  so because `typing(on)` is the existing method), `clock`, `stopReason`; methods `ready(on)`,
  `profile(name, colour)`, **`pickWorld(demo)`** (not `world()`: `world` is the WorldSpec field),
  `setOptions(partial)`, `ping(kind, pos)`. The `entries` event keeps `entries / events / outcomes`
  (the scripted clients read them) and adds `steps: EntryStep[]` (`{ entry, before, after, events,
  outcomes }`, `steps[i].before === steps[i-1].after`) and `catchUp` (true only for a welcome's
  entries). `status: 'stopped'` carries `stopReason`: the socket's close code (4007, 1008, 4010),
  or for a `refused` / `closed` message the code the server closes with (`REFUSED_CLOSE[code]`,
  4010); none after `stop()` / `leave()`; `connect()` clears it.
- **Client plumbing** (`src/client/room/`, no UI yet): `config.ts` (`roomsEndpoint(build, loc)`,
  `pageBuild()`, `roomLink(loc, code)`), `api.ts` (`RoomsApi` with `health / listRooms / getRoom /
  createRoom / uploadWorld`, results `ok | unavailable | outdated | refused(code, status,
  message)`; a server without rooms (404 `bad_request`) and 5xx other than `server_full` are
  `unavailable`; `engineDiffers` treats `'dev'` as matching), `profile.ts` (profile and seat tokens
  as designed, plus `COLOUR_KEYS` / `colourName` for "You are Kari 2, green"; an injectable
  `KeyValueStore` for tests), `qr.ts` (`qrMatrix`, `qrSvg(text, label)`; `qrcode-generator` 1.4.4
  pinned; nothing imports `qr.ts` yet, the lobby should `import()` it).
- **Boot**: `bootRoute` returns `{ kind: 'room', code }` for a valid `?room=` (any `?room=`
  parameter wins over `?world=`; an invalid one → `start`); `main.ts` shows the start page for it,
  with the `room.noServer` notice when the build has no endpoint.
- **i18n**: ~105 keys in en and nb (`room.*`, `lobby.*` incl. `lobby.options.*` and the 12
  `lobby.colours.*`, `party.*` incl. `tagAway / tagLeft / tagDown / prevTeammate / nextTeammate`,
  `chat.*` incl. `close / pings / unread`, `ping.*`, `keys.chat`, `keys.cycleFollow`,
  `help.interactRoom`, `tile.usableHintRoom`, `ctx.interactHintRoom`). Extra beyond the list:
  `room.sub`, `.retry`, `.joining`, `.creating`, `lobby.title`, `.you`, `.players`.
  `lobby.defaultName` is `Player {n}`; `party.down` takes `{n}`.

## D2 as built

- **Characterization first** (commit d4f3b0b): `tests/client/session-characterization.test.ts` plays
  six single-player runs (western ×2, ship, teen ×2, dream; talker / explorer / cautious / newbie bots,
  300 decisions each) through the controller's calls: `uiAction`, talk / persuade intents,
  `dialogueReply` / `dialogueLeave` / `trade` (buy and sell), click-to-travel with `travelTick`
  every 25 steps, the client's `OfflineGmDirector` through `takeHooks` / `applyGm`, and canned NPC
  voice answers for every other `takeVoiceRequest`. Each step records toasts, narration, history,
  voice requests and lines, onboarding, trade / mode, new log and GM-log lines and a log hash into
  `session-characterization.jsonl` (2639 lines). It stayed byte-identical through the refactor;
  regenerate only with `UPDATE_CHARACTERIZATION=1` and a reason.
- **`GameSession`** (`src/client/session.ts`): `pid` is a readonly field (`playerId` and `me` read
  it); `SessionInit.room = { state, pid }` builds a session on a given (perspective) state with
  `replicaMode` set: no `createGame`, no intro hook, no `drainEngineQueue`, and `afterChange` skips
  the GM hooks and the drain. `act` = step + `protected absorbStep(before, after, events, mine?,
  out?)` (`mine = { action, tookTurn }`; without it narration is not cleared, no history, no voice
  turn, no onboarding count). `applyGm` = recheck + `applyGmActions` + `protected absorbGm(before,
  after, events, actions, meta, out?)`. `travelTick` = `nextTravelAction()` (pre-step rules) + step
  + `protected travelGoesOn(out, hpBefore)` (the post-step rules: arrived, new hostile, hurt,
  choice…; the "new hostile" rule stays post-step, as single player has it). Chains:
  `replyPlan(index)` / `dialogueReplyActions(index)` / `replyAnswer(plan, gained)` /
  `keepConversation(...)` and `tradePlan(t)` / `tradeActions(t)` / `keepShop(...)`; `talk` is
  protected. `Outcome.pending?` (a room's sent action); `confirmCursor` treats it as accepted.
  `emptyOutcome` and `merge` are exported. `clientLog()` (protected) feeds the view's GM log.
- **`perspective(state, pid)`** (`room/perspective.ts`): the party rotated (`[pid, …the rest in
  order]`), shallow (players, area shared), memoised in a WeakMap per state; `state` itself for the
  lead, a party of one and a pid not in the party.
- **`RoomSession`** (`room/room-session.ts`): `new RoomSession({ client, prefs? })` from a joined
  client with a replica (playing welcome or `run`); `replica` (client.state), `cameraState`,
  `writable` (true only inside `absorb` / `rebuild`), `queued` (`{ action, area, turn, intent }`),
  `followed`, `overlay` (LogOverlay), `run`. `attach(apply)` subscribes to the client (entries →
  `absorb`, `state` welcome / snapshot → `rebuild`, refusal / stale → `onMessage`) and ignores events
  once `client.run` differs from the session's run (D3 relaunches). `act` → dry run (`stepTurn` on
  the raw replica; `illegal` → `explainInvalid` toast, `down` → nothing; skipped for `transition` and
  `exitCountdown.turnsLeft <= 1`) → `client.input(actions, intent)` → `{ pending }`; not joined →
  `room.offline` toast. Intents: `wait` for wait, `travel` for travel steps, else `decide`. The same
  turn action for the same turn is not resent. `dialogueReply`, `trade` (buy / sell) and persuade
  from a dialogue send one input (`[choose_option, talk]` / `[choose_option, persuade]`); chain
  dry runs check only the first action (the reopen `talk` may fail harmlessly). `applyGm` is a no-op
  in rooms (no local GM, NPC voice actions not applied). The HUD name is the player's own
  (`players[pid].name`; single player keeps `world.player.name`).
- **Absorb**: per step, turn → `absorbStep` with this pid's first ok outcome as `mine`, then the
  chain bookkeeping when the entry carries the pending chain's actions (healer line →
  `overlay.add`, `keepConversation` / `keepShop` when the talk reopened the dialogue); gm →
  `absorbGm` (intro card from the GM intro entry, area card from absorbStep then the GM's
  area_enter text); join / away / back / leave / return → toasts `party.joined / away / back /
  left` (`return` says "back"), never for the own pid, none in a catch-up batch (which also keeps
  the narration card as it was, null on an area change). After the batch: a choice ends travel; the
  next travel step is sent once the previous one resolved (also when the player is short of
  energy: the server keeps it pending); a refused travel step ends travel without a toast; the
  followed teammate is updated. `rebuild()` (welcome / desync snapshot) clears narration, queued,
  chain, travel and the cursor and primes rules without toasts; it returns `areaChanged: true`.
- **Spectator**: while `me.down`, `followed` = the nearest standing teammate (Euclidean), kept
  until down or left; `cycleFollow(±1)` over standing teammates in party order; `cameraState` =
  `perspective(replica, followed)`; back to null on getting up.
- **ChatModel** (`room/chat-model.ts`): `EMOTES`, `CHAT_TIMING`, `isEmote`, `bubbleMs`; `push(line,
  now)` (live: bubble, unread, typing cleared; false for a known id), `merge(lines)` (welcome:
  quiet, no bubbles or unread), `setTyping`, `typing(now)` (a Set without self), `bubbles(now)`,
  `canSend(now)` / `noteSent(now)` (one shared 1/s), `draft(text)` (`{ count, left, over, counter }`
  in code points), `setSheetOpen(open)`, `recent(n)`. `self` is the client's seat.
- **Server fix**: `newRun` sends the roster (with the new pids) before `run`, so a client knows its
  pid when the run arrives and can build its session before the GM's intro entry.
- **Harness** (`tests/client/room-harness.ts`): `MemRoom` (RoomManager + ManualScheduler +
  `TEST_TIMING`, seeds from `seed`), `client(name, { host, token, colour })`, `join(...)`,
  `flush()`, `advance(ms)`, `sent(c)` / `inputs(c)`, `craft(fn, clients)` (replaces the server
  state, e.g. a `roomMap` with placed actors, and makes the clients refetch it as a snapshot),
  `dispose()`. Client timers run on the manual scheduler.
- For D3: build the session synchronously on `welcome` (playing) and on the `state` event with
  reason `run`; call `travelTick()` once when an outcome has `travel: true` (later steps come from
  the entries); route `session.cameraState` to the renderer; use `queued` for the HUD mark; wire
  ChatModel to `welcome.chat` (merge) and `chat` frames (push).

## D3 as built

- **RoomLink** (`room/link.ts`): builds the `RoomClient` (browser `WebSocket` by default; `socket`, `store`,
  `doc`, `engine`, timers injectable, so `tests/client/room-link.test.ts` runs it on the in-memory harness).
  It saves the seat token on every welcome, owns the room's `ChatModel` (welcome chat merged, chat frames
  pushed, typing frames to `setTyping`; `self` = seat), and sends `presence` on change only:
  `setMenu(reason, open)` plus `document.hidden` give `menu`, else `playing` (resent after a reconnect
  only when it is `menu`). Events: `welcome { first, renamed }`, `run`, `changed`, `chat`, `status`,
  `toast`, `reload` (outdated: sticky Reload toast, the view stays), `end { key }` (back to the start
  page; the token is dropped except for a full room, another tab or a world fault). A bad token drops
  the seat, toasts `net.badToken` and reconnects as new after the client's own stop. Close 4007 →
  `room.otherTab`, 1008 → `room.notAllowed`, any other stop without a notice → `net.roomClosed`.
  `error not_host / bad_phase / invalid` → `room.notAllowed` toast. `leave()` drops the seat token.
  `roomWorldEntry(world, worldId, worldIndex())` names the bundled demo (matched by title and language)
  as `origin`.
- **Menu reasons in use**: `panel:backpack|help|rules` (the controller, from the `panel` intents),
  `settings` and `profile` (main.ts). **D4: the chat input and the phone sheet call
  `link.setMenu('chat', open)`**; the controller gets the link as `host.room` (`RoomPresence`).
- **GameController** (`host.room` set): `pumpGm` and `autosave` return at once, `dialogue: null`;
  `applyRemote(out)` for the room's outcomes (stops a walk when a panel took the input); renderer syncs
  are serial (`queueSync`: batches waiting while one runs go in one sync with their events joined; more
  than `SYNC_BACKLOG` (4) of them or a hidden tab → `sync(state, [])` + `skipAnimations()`, not
  awaited; each awaited sync bounded by `SYNC_TIMEOUT_MS` 1.5 s). `out.travel` → one
  `session.travelTick()` (no 70 ms loop). The keydown that stops travel skips `isTextTarget`. The
  renderer (`start`, syncs) and the exit marker's fog read `session.cameraState` (a new base getter on
  `GameSession` returning `state`; RoomSession overrides it). `setStateForTest` throws in a room. The
  open panels are reported as presence and cleared on dispose. (`renderer.setFollow`: see D4 as built.)
- **RoomFlow** (`room/flow.ts`, a lazy chunk with link, session, api, profile and the net client;
  main.ts loads it at boot only when `roomsEndpoint` gives an endpoint, and through `RoomAppHost` it
  drives the App's screens, renderer and controller). main.ts keeps thin hooks: `roomFlow()`, `room`
  (the handle), `joinRoom(code)` (?room= links), `leaveRoom()`, the card view, `lobbyVm()` and the
  sheet in `render()`, `flow.closeRoom()` in `showStart`, `setMenu('settings')`. The start page's
  card refreshes on boot, on ↻ / Retry and every 15 s while the start page is visible. `createRoom(worldId?)` (default:
  the first demo of the start page; a world kept in this browser is sent as `world`), `joinRoom(code)`
  (`getRoom` first: 404 → start page + `net.noRoom`; then the stored token, else the stored profile,
  else the name sheet), `openRoom`, `leaveRoom` (`link.leave()` + `showStart()`; never `clearRun`).
  `showStart` closes any room. The address bar is `?room=CODE` while in a room. Screens: the welcome's
  phase decides (`syncRoomScreen`): playing → `startRoomRun` (a `RoomSession` at once, attached; its
  outcomes buffered until `controller.start()` resolved, then applied merged); lobby → `screen: 'lobby'`;
  ended → the end screen of this page's session if it played the run, else `endView(client.world,
  client.state)` with the room block. `run` → the session and controller are disposed and relaunched
  (between them the lobby view shows). `extraVm` adds `room` (RoomView) for the end screen's room block,
  the help overlay's "Leave room" and the reconnect banner (20 s → its "Leave room"). The renamed toast
  ("You are Kari 2, green") carries "Change" in lobby / ended only. `__anyworld.room` (RoomHandle):
  `code, status, phase, seat, pid, host, run, n, state(), hash(), chat(), roster(), session, link`
  (`bubbles()` and `autoplay` are D4 / D5).
- **UI**: `UiViewModel.screen` + `'lobby'`, `lobby?: LobbyView`, `room?: RoomView | null`,
  `profileSheet?`; `StartView.rooms?: RoomsCardView`; one callback `onRoom(RoomIntent)` (refresh, create,
  join, profile / profile_cancel / change_profile, ready, start, world, pick_world, options, share,
  leave, reload). `components/rooms.ts`: `RoomsCard` (kept across re-renders so the code field keeps
  its text; `cleanCode` upper-cases to the code alphabet), `ProfileSheet` (name + 12 swatches, taken
  ones dimmed; takes the keys like the settings dialog, Esc cancels). `components/lobby.ts`:
  `LobbyScreen`, re-rendered per part (share, world, roster, options, actions) so a roster change
  never takes the focus from an option select. "Play with friends" sits under each demo card and in
  "Your worlds"' tools while the card status is ok. `EndScreen.update(v, vocab, room?)` swaps "New
  world" / "Same world again" for the room block (host: Play again, Choose another world; everyone:
  Ready, Leave room). `HelpOverlay` has "Leave room" with `room.leaveRunHint` in a room (the in-game
  menu; single player has no menu with "New run"). `GameUi.toast(text, tone, action?)`;
  `ToastStack.push(text, tone, action?)` and `dismiss(id)`, sticky entries without timers and outside
  `max`. Styles in `styles/rooms.css`. `InputLayer` + `'lobby'` (no game keys).
- **Bundle**: the static start bundle is 298.6 kB gzip (budget 300; 297.8 before D3). Lazy: `room/flow.ts`
  (~14 kB), `components/lobby.ts` (LobbyScreen and ProfileSheet, ~2.8 kB, imported by ui.ts the first
  time a view has `screen: 'lobby'` or a `profileSheet`), `room/qr.ts`. `boot.ts` checks `?room=` with
  its own `ROOM_CODE` regex (a test checks it equals the protocol's `Code`), so the start bundle no
  longer pulls in the protocol's zod schemas. **D4: keep new room UI out of the entry the same way**
  (ChatPanel, PartyOverlay in lazy modules); the entry has under 1.5 kB left.
- **Deviations**: only the "Play together" card, the end screen's room block, the help's "Leave room",
  the banner and toast actions are in the main UI bundle. The lobby has no chat panel yet: D4's `ChatPanel` must
  be mounted in the lobby screen too. The host-leaves test expects the player connected longest to
  take over (the server's rule), which after a reload is not always the second player.
- **Tests**: `tests/client/room-link.test.ts` (presence, tokens, rename, bad token, another tab, no
  room, leave, chat merge, `roomWorldEntry`); `tests/ui/input.test.ts` (lobby layer, text layer);
  `tests/ui/toasts.test.ts` (action, sticky). The harness now delivers frames sent just before a close
  (as a real socket does) and offers `socketFactory(sent)` and `timers()`. **e2e-mp**:
  `e2e-mp/playwright.mp.config.ts` (5183 / 8797, `.data/e2e-mp-<time>` removed by `teardown.ts`,
  `MP_TIMING`, `MP_SEED` 4242, `MP_LIMITS`, anti-throttling flags, `reuseExistingServer: false`) and
  `mp-lobby.spec.ts` (3 tests, ~1.5 min): card create with the name sheet, list join, name clash toast
  and Change, ready count, start, own pids and hash agreement, a phone mid-run join by link after a
  single-player run, reload keeps the seat, host handover, "Leave room" from help keeps the
  single-player save, phone lobby by code without horizontal overflow, `?room=ZZZZ`, server down
  (single player still starts), outdated server (Reload). Run with
  `xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts --reporter=line`.

## D4 as built

- **Start bundle relief (deviation, outside the step's list).** The entry was at 299.4 / 300 kB gzip.
  It carried the world-generation balance step (`engine/balance`, the sim bots, zod's JSON-schema
  code) only for the on-page fallback when workers fail. `balanceWorld` moved to `src/llm/balance-run.ts`;
  `generate.ts` defaults to `balanceHere` (a dynamic import of it); the page-side `workerBalancer`
  moved to `src/llm/balance-client.ts` (main.ts imports it; `balance-worker.ts` re-exports it and stays
  the worker entry). The entry is now about 246 kB gzip. Generation behaves the same; `tools.test.ts`
  and the generate tests pass unchanged.
- **Main bundle (small hooks only).** `input.ts`: `resolveKey(ev, layer, verbs, room)`; in a room Enter →
  `chat`, Shift+Enter → `interact`, `[` / `]` → `follow`, `/` → `chat` in every layer but `none`, `text`,
  `settings`, `start`, `loading` (so also in the lobby and on the end screen); `attachKeyboard(..., inRoom)`;
  `keyHelp(..., room)` shows ⇧ Enter, Enter / `/` chat and `[` `]`. `ui.ts`: `RoomIntent` `chat` and
  `follow` (handled before the gfx-lost guard), `GameUi.roomSlots()` — empty hosts `strip` (inside the
  status strip, `Hud.party`), `pill`, `banner` (top-centre), `side` (right column under the rules),
  `tools` (start of the hotbar tools), `sheet` (game screen, measured by `panelRects`), `log`, `lobby`
  (`LobbyScreen.chatHost`), `end` (after the end screen's body); `.aw-room-slot:empty` is hidden in
  ui.css (phones' grid would otherwise place them). Room hint variants: `tileCard(tile, room)`,
  `GameSession.interactHintKey` (`ctx.interactHintRoom` in `RoomSession`).
- **Renderer.** `setPartyColours(Map<actorId, colour>)` recolours the existing ring (and the pulse)
  through `ActorLayer.setPartyColours`, kept across `setWorld`; `setFollow(actorId)` sets `playerId` and
  re-flags the views (`ActorLayer.setFollow`: `isPlayer`, pulse added / removed, ring opacity). The
  controller calls `setFollow` from `syncFollow` before each room sync (and at start) when
  `leadPlayer(cameraState)` changes; `cameraChanged()` redraws after a cycle.
- **Lazy room UI** (in the `room/flow.ts` chunk, with `styles/party.css` as its own CSS chunk):
  `room/party-view.ts` (DOM-free: `partyMembers`, `turnView`, `PillTimer` 450 / 250 ms, `bannerView`,
  `partyColours`), `ui/components/chat.ts` (`ChatPanel` with modes dock / sheet / inline, `ChatButton`),
  `ui/components/party.ts` (`PartyStrip`, `TurnPill`, `PartyBanner`), `party-overlay.ts`
  (`PartyOverlay`), `room/room-ui.ts` (`RoomUi`, one per link, made in `openRoom`, `attachRun` after
  `controller.start`, disposed in `closeRoom`; one rAF loop re-projects the overlay and refreshes the
  rest every 100 ms with keyed renders).
- **Behaviour choices.**
  - "Off screen" is in practice "out of sight": the camera keeps every visible actor framed, so a
    visible teammate is always on screen unless a HUD panel covers them. A teammate in the fog but
    inside the view gets a faint italic tag where they stand (`.aw-name-tag.is-fogged`) instead of
    an edge arrow; edge arrows are for points outside the view.
  - The desktop dock closes after a sent line (the keys are the game's again); an empty dock input
    closes on blur unless the focus went to its own emote / ping buttons. The phone sheet stays
    open after a line; the chat button opens it without the keyboard (Enter on a hardware keyboard
    focuses the input). Presence `menu` while the dock input or the sheet is open (`setMenu('chat')`).
  - The own player's lines also get a bubble (over their own head). Ping lines get markers, not
    bubbles; markers come only from live lines (a welcome's history shows none).
  - The down card is the banner (`party.down` + "Watching Kari ‹ ›"); the hotbar and context bar are
    dimmed (`data-room-down`). The turn pill is hidden while down. The banner sits above a narration
    card (z-index), and is empty while reconnecting (the root's reconnect banner shows).
  - `RoomLink` emits `chatError` (`chat_rate` / `chat_long`) → "Wait a moment" in the panel.
    `RoomSession.follow(pid)` (a party chip while down).
  - The pill shows "2 of 3 acted" while the turn waits, "Kari is deciding" once this player acted;
    phones show "2/3" + bar in the strip instead (the pill slot is hidden there).
- **Handle.** `__anyworld.room.bubbles()` (shown bubbles: `{ seat, text, kind: bubble | typing }`) and
  `onScreen(seat)`.
- **Tests.** Unit: `tests/client/party-view.test.ts`, `src/client/render/party.test.ts` (ring and
  follow on `ActorLayer`), `tests/ui/input.test.ts` (room keys). e2e-mp: `e2e-mp/mates.ts` (scripted
  teammates as bare `RoomClient`s through the dev proxy, `walkTo` / `walkAwayFrom` on BFS distances,
  `act` that answers open choices first, a `room(page, fn, arg)` handle helper), `mp-chat.spec.ts`
  (3 tests: desktop chat, dialogue + backpack, phone sheet / ticker / overlap with the keyboard up),
  `mp-party.spec.ts` (2 tests: rings, tags, strip, pill, idle teammates, away / back, exit countdown;
  spectator in a Hard room within the 90 s bound). Deviation: in the spectator test the page's player
  gets up by itself (the teammates wait out `REVIVE_SELF_TURNS`) instead of a teammate walking over,
  which keeps it deterministic; the help-revive rule is engine-tested.
- **For D5.** `autoplay` on the handle is still to add. A player held in place (lassoed) has its moves
  refused locally (no input sent): an autoplay bot must fall back to `wait`, as `mp-party` does.

## D5 as built

- **Autoplay** (`room/autoplay.ts`, its own lazy chunk behind the flow chunk): `Autoplay` with an
  `AutoplayHost` (`client`, `live()` → the run's session and controller, `say(text)`). A sim bot
  (`botByName`, default explorer) decides on the raw replica for this pid, as `ScriptedClient` does:
  one turn action per ready turn, free actions one at a time (the wait ends on the entry carrying this
  player's own free action, a refusal of a free action, or a 1 s watchdog), an open choice first, a
  locally refused action replaced by a wait. Every action goes `controller.actNow(a)` (now returns its
  Outcome) → `RoomSession.act`. A chat line about every `chatEvery` (40) entries through `RoomUi.say`
  (typing for 300 ms, then the panel's send path). It records area changes and the run end as
  `{ area, n, hash }` (n = entries after that entry; area -1 for the end) from the moment it is made.
  Handle: `__anyworld.room.autoplay(on, { bot, seed, chatEvery })` (a Promise) and `autoplayStats()`
  (`sent`, `refused` locally with `refusals` by text, `serverRefused`, `said`, `areas`, `faults`).
  Build gate: `__ANYWORLD_AUTOPLAY__` (vite.config.ts: the dev server, or `ANYWORLD_AUTOPLAY=1`); the
  static and production builds contain neither the module nor the sim bots (checked on `--mode static`).
- **`e2e-mp/mp-exit.spec.ts`**: as §7, with these choices. B joins by the link with no stored profile
  (the sheet, a swatch); A and C have stored profiles. C's tap is checked as "C moved", since the first
  touch can shift the camera's insets so the step is not always onto the tapped tile. Short-lived UI
  (the pill, typing, bubbles, the exit banner) is recorded by a 40 ms sampler in each page and asserted
  afterwards. The bots are explorer / cautious / explorer with seeds 11–13. The autoplay is turned off
  before "Play again" (it would play the new run). About 2.5 minutes in all; the run itself 90–125 s.
- **Fixes**: `PartyOverlay` puts a bubble under the feet when its own top corners are under a HUD
  panel (before, only the head point was checked, so a bubble could hide under the goal bar);
  `RoomLink` logs `bad_phase` quietly once the client is out of the playing phase (an input or ping that
  crossed the run's end no longer toasts "not allowed").
- **Tests**: `tests/client/autoplay.test.ts` (two autoplayed sessions on the in-memory room reach the
  next area with equal marks, the chat script speaks, off stops the inputs), `room-link` (bad_phase
  quiet after the run, a toast while playing), `mp-exit`.

## Constants

Turn pill shown for parties of 2+, after 450 ms of waiting, hidden 250 ms after; serial sync timeout
1.5 s; renderer backlog snap after 4 batches; room list refresh 15 s;
API timeout 5 s; reconnect banner "Leave room" after 20 s; bubble `4 s + 50 ms/char`, max 10 s, ~28
characters per line, 3 lines; column fades after 20 s, 6 lines; chat lines in the log ticker 4 s; ping marker 8 s; typing
refresh 3 s (server expiry 8 s); counter from 160 of 200 code points; send throttle 1 s; tokens kept
for 20 rooms / 7 days; emotes 👍 😂 😮 ❤️ 👋 ❓.

## Review notes

Three critiques (rules, client, ux-risk) of the first draft; one line each.

- Accepted: late join / ended welcome go straight to game / end screen, no lobby step (§2.3; rules 1, ux 7).
- Accepted: the desktop chat input sets `presence: menu` while open, like the phone sheet (§1.2, §4; rules 2, ux 12).
- Accepted: in-game "Leave room" with the no-character warning; room mode never calls `clearRun`; hidden end-screen buttons named (§1.2; rules 3).
- Accepted: no colour dimming before `hello`; toast the name and colour actually given with a Change action (`profile` kept for it) (§2.3; rules 4, client 11).
- Accepted: `/` opens chat in every non-text layer and the input is clickable; added a server fix so stopping typing does not clear a dialogue's busy (§2.7, §4; rules 5, client 10).
- Accepted: `Tab` stays the backpack; spectator cycles with `[` / `]` and the pill (§3.4; rules 6, client 10, ux 6).
- Accepted: NPC lines as bubbles for nearby players deferred to MP4 and named in MP3.md (§3.3; rules 7).
- Accepted: spectator e2e made deterministic by keeping teammates busy and out of reach, check reduced to pill and follow, bounded (§7; rules 8, ux 11). Rejected the separate fixture-world idea: not needed once the page's player is the only target.
- Accepted: dropped the QR fallback encoder, path-distance follow and tap-to-centre from scope; `world` is canonical, `start.demo` kept server-side for bots only (rules 9).
- Accepted: code-point counting matches `codePoints` (❤️ is 2); slow-down feedback also on emotes and pings (§4; rules 10).
- Accepted: the GM line is worded for MP4 and said so (§2.4; rules 11).
- Accepted: "Kari is deciding" and "The party moves on in {n}" instead of "waiting" (§3.2, §3.5; rules 12).
- Accepted: `RoomClient` emits per-entry steps and a `catchUp` flag (§1.1; client 1).
- Accepted: dialogue / trade / persuade chains go as one free-action input with bookkeeping on absorb; greeting stays in the shared log, the healer line in a client-only overlay (§1.1; client 2, ux 1).
- Accepted (merged): client 3 and ux 2 together — `state` is a plain field *assigned* the perspective in `absorb`, every writer guarded, the raw `replica` for dry run and hashes; the `view` getter is dropped (§1.1).
- Accepted: dry run reads `outcome.reason` and sends `not ready` as queued; skipped for `transition` and the last countdown turn so it never makes maps (§1.1; client 4, ux 9).
- Accepted: controller reads routed to `cameraState` for renderer and overlays; travel-stop keydown skips text targets (§1.2; client 5, ux 6). The player reads stay on `state`, now the perspective.
- Accepted: `renderer.setFollow` re-flags actor views; `setPartyColours` recolours the existing ring (§1.3, §3.1; client 6).
- Accepted: relaunch session and controller on `run`; session created synchronously on `welcome`; `roomWorldEntry` adapter (§1.1, §1.2; client 7).
- Accepted: `stopReason` in the stopped status; the bad-token rejoin path written down (§2.3, §2.7, §5; client 8).
- Accepted: entries are the only presence toast source, none for catch-up; chat merged by id; sticky toasts exempt from `max` (§1.2, §3.6, §5; client 9).
- Accepted: `lobby` added to `InputLayer` and the screen union (§1.2; client 10).
- Accepted: lobby world card tagline and colour from the demo catalogue (§2.4; client 11).
- Accepted: room specs moved to `e2e-mp/` (instead of `testIgnore`), `ANYWORLD_TEST_LIMITS`, test seed via `RoomDeps.seed` (§2.7, §7; client 12, ux 3).
- Accepted: anti-throttling Chromium flags; sync timeout and a no-animation path while hidden (§1.1, §7; ux 4).
- Accepted: phone elements merged into the portrait grid (tools, strip, banner rows), chat in the log ticker, `panelRects` and avoid rects, overlap check at 390×844 (§3.6, §4, §7; ux 5).
- Accepted: Enter / Esc handled in the chat input, form submit with `enterkeyhint`, IME composition skipped; room variants of the interact hints (§4; ux 6).
- Accepted: "Play with friends" on the world cards with defaults, name asked once, joiners go straight in with the stored profile (§2.2, §2.3; ux 7).
- Accepted: turn pill shows after 450 ms, hides after 250 ms (§3.2; ux 8).
- Accepted: a single-player characterization recording before the refactor; the controller room mode moves from D2 to D3, where the first browser spec reaches it (§7, §8; ux 10).
- Accepted: names via `textContent`; `/` opens chat from narration while Enter still skips the card; e2e-mp budget 10–15 min, run in D3–D5 only (ux 12).
