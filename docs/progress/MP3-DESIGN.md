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
| `party-overlay.ts` (DOM) | name tags, chat bubbles, typing "…", pings, teammate edge arrows; the MapOverlay pattern (re-projected each frame through `renderer.tileToScreen`) |
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
`RoomSession` never steps the engine for real and **never writes the replica**: `state` is always the
object `RoomClient.state` holds (so the `hashState` it reports is the server's). The single-player
`afterChange` drains `gmQueue` into a new state object; the room session skips that (`replica: true`),
and narration, rules, dialogue history and audio are derived from `(before, after, events, outcomes)`.

Data flow of one turn:

1. A key, tap or click reaches `GameController` as today → `session.uiAction(a)` → `act(a)`.
2. `RoomSession.act(a)` **dry-runs** `step(state, a, { playerId: pid })` locally: an `invalid` event →
   the same `explainInvalid` toast as single player and nothing is sent. Otherwise
   `client.input([a], intent, busy?)` with `intent` = `travel` while click-to-travel runs, `wait` for
   the wait action, else `decide`. It returns an Outcome with `pending: a` (the HUD marks the queued
   action; a ghost marker on the target tile) and `changed: false`.
3. Coalescing (input bucket 20/s): one turn input per `state.turn`; a different action for the same
   turn replaces it (the server keeps the latest), the same action again is not resent (key repeat).
   Free actions (talk, choose_option, choose_perk, toggle_sneak) are sent at once; the server appends
   them as `advance: false` entries.
4. `RoomClient` emits `entries { entries, events, outcomes }` → `RoomLink` → `session.absorb(...)` →
   one Outcome per batch → `controller.apply(out)` (renderer sync, toasts, tooltips) as today. The
   controller syncs the renderer **serially** (await each `sync`); with a backlog over 4 batches it
   syncs the latest state with no animation (a tab that was in the background catches up at once).
5. `state` events (welcome snapshot, desync snapshot, new run) → full rebuild: `renderer.setArea` +
   `sync(state, [])`, narration cleared, travel stopped.
6. `refusal` (to this seat only) → `explainInvalid` toast; `error stale` → drop the pending mark and
   decide again (travel resends its next step).

### 1.2 What changes in `GameSession` and `GameController`

`GameSession` (refactor only, single-player behaviour identical, `tests/client/session.test.ts` unchanged):

- `playerId` becomes a field (`pid`, default `state.party[0]`), and `me` reads `state.players[pid]`.
- `act()` is split into `act(a)` (single player: `step` + `absorbStep`) and `protected absorbStep(before,
  after, events, mine?)` (dialogue history, narration on area change, voice, rules, onboarding count,
  end of run). `applyGm` likewise keeps `applyGmActions` and moves the narration part into
  `protected absorbGm(before, after, events, hook)`.
- `travelTick()` is split into `nextTravelAction(): PlayerAction | null` (the stop rules: destination
  reached, a new hostile in view, a choice open) and the step.
- every view helper that reads the lead (`viewModel`, `highlights`, `preview`, `describeAt`,
  `interactTargets`, `legalActions(...)`) reads `this.view` instead of `this.state`: a getter that is
  `state` in single player and `perspective(state, pid)` in rooms.

`RoomSession extends GameSession`: constructed from the `welcome` (world, replica, pid); `act` as in
§1.1; `absorb(entries, events, outcomes)` walks the entries: `turn` → `absorbStep` with this pid's
outcome as `mine`; `gm` → `absorbGm(hook)` (intro and area cards come from the server's GM entries);
`join` / `away` / `back` / `leave` / `return` → party toasts ("Kari joined", "Kari is away", "Kari is
back", "Kari left the map"); after the batch, if travel is on and `pid` is engine-ready on a new
`state.turn`, `nextTravelAction()` is sent with intent `travel`. It also keeps the clock view, the
roster, the followed teammate (§3.4) and the queued action. No autosave, no `SavedRun`; the
single-player autosave is never read, cleared or written by a room.

`GameController` gets an optional `room?: RoomLink` in `ControllerHost`:

- no `GmRunner` requests (`pumpGm` returns at once; the server is the GM), no NPC voice (`dialogue:
  null`), no autosave, no `setAddress(runUrl)` (the address bar keeps `?room=CODE`);
- the travel loop is entry-driven (above) instead of the 70 ms timer;
- the renderer gets `cameraState` (§1.3), the PartyOverlay is created next to the MapOverlay, and
  `presence` is sent on menu changes: `menu` while the backpack, help, rules, settings or the phone
  chat sheet without typing is open, or the tab is hidden; `playing` otherwise (sent on change only).

`App` (main.ts) gets `openRoom(code)`, `createRoom(opts)`, `leaveRoom()`, the `lobby` screen and the
room callbacks; `launch()` is shared, with the room flavour skipping `clearRun`, `runAi` and autosave.

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

Two perspectives exist in a room: `view` (always this player: HUD, hotbar, choices, hints) and
`cameraState` (this player, or the followed teammate while down, §3.4) for the renderer and the
PartyOverlay (fog, camera follow, sight radius).

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

"Create a room" opens a sheet: world (the demo worlds, with the same cards as the start page, or one
of "Your worlds" from this browser, which is uploaded), max players (2–12, default 8), turn deadline
(1–5 s, default 2 s), difficulty (the start screen's). `POST /api/rooms { engine, demo | world,
options }` → `{ code, token }`; the token is stored for the code and the client connects **at once**
(`hello { token }`, so the creator is host: MP2 gap "connect the creator first"); address bar
`?room=CODE`. Errors: 409 → `net.outdated` with Reload; 503 → `net.serverFull`; 400 invalid world →
`room.worldInvalid` with the first error; 429 → `room.tooMany`.

### 2.3 Join

- **Link** `?room=K7QX`: `bootRoute` gets `{ kind: 'room', code }` (a valid `Code` after upper-casing;
  it wins over `?world=`; the saved single-player run is never touched). `GET /api/rooms/:code` → 404
  → start page with `net.noRoom`. With a stored token → connect straight away (a reload rejoins the
  same seat); without one → the lobby's join step (name and colour) first.
- **Code**: a 4-character field on the card (upper-cased, the code alphabet only, Enter submits).
- `bad_token` → the token is dropped and the client joins as new (toast `net.badToken`).

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
  joining?: { name: string; colour: string; taken: string[] } // the join step
}
```

Top to bottom: the code in large type with Copy link / Share (`navigator.share` on phones, else the
clipboard with `room.linkCopied`) and the QR code; the world card (host: "Change world"); the roster
(colour dot, name, "host", ready tick, presence: away / off); options (host: editable, others: read
only); **the GM line** `lobby.gmReadsChat`: "The game master reads the chat; chat lines are sent to
the AI provider."; Ready toggle; host: Start ("2 of 3 ready" beside it, never required: the host can
start any time, fast first); Leave; the chat panel. The join step (no seat yet) asks for name
(prefilled from the profile, or `lobby.defaultName` + a number) and colour (the 12 `PLAYER_COLOURS`
as swatches, taken ones dimmed) before `hello`.

### 2.5 Share link and QR code

The link is the **page's** origin, not the server's: `${location.origin}${location.pathname}?room=CODE`
(on Pages `https://any.dv8.no/?room=K7QX`). QR: the `qrcode-generator` package (kazuhikoarase, MIT,
no dependencies, 1.4.4 pinned exactly like the others, ~20 KB), imported lazily by the lobby so it is
not in the start bundle; `room/qr.ts` turns its module matrix (`getModuleCount`, `isDark`) into one
SVG `<path>` (error correction M, 4-module quiet zone, dark on white also in dark themes). A unit test
checks the matrix size and the three finder patterns for a known link. Fallback if the package cannot
be added: a byte-mode encoder for versions 1–6 (a link under 100 bytes) in the same file, ~250 lines.

### 2.6 Play again

When the replica's `status` is `won` / `lost` the end screen gets a room block: host → "Play again"
(same world, `start`) and "Choose another world" (back to the lobby screen's world picker; a demo via
the new `world` message, an own world via `POST /api/rooms/:code/world`); everyone → Ready toggle,
"Leave room". The `run` message brings everyone into the new run (full rebuild, §1.1 step 5).

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

`RoomClient` keeps `room`, `options`, `typing` (seats typing), `clock` (last frame) and adds
`ready(on)`, `profile(name, colour)`, `world(demo)`, `ping(kind, pos)`, `setOptions(...)`. Tests: new
cases in `rooms-room` and `protocol`. Also a test-only `ANYWORLD_TEST_SEED` (ignored in production,
like `ANYWORLD_TEST_TIMING`) so browser tests get fixed run seeds.

## 3. In game

### 3.1 Other players

- **Colour**: a flat ring under every player actor in its seat colour (own included), from
  `renderer.setPartyColours(Map<actorId, colour>)` (a new optional renderer method, feature-detected
  like `itemThumbnail`; single player never calls it). The seat → pid → actorId map comes from the
  roster and the replica.
- **Name tags**: PartyOverlay DOM labels above other players' actors on visible tiles (`cameraState`
  fog = 2), in the seat colour with a dark outline; dimmed with "away" for `off` / `idle` seats, and a
  "busy" glyph while they are in a dialogue, trade or menu. Own name is not tagged.
- **Teammates off screen**: a small coloured edge arrow with the name (`edgeArrow` /
  `placeEdgeMarker` from map-overlay.ts, clear of the HUD), so a party can find each other.
- **Party strip** (top bar, desktop; a row of dots on phones): one chip per party member: colour,
  name, hp bar, state (acted ✓, deciding, busy, away, down). Tapping a chip centres the camera on
  them for 2 s (or follows them while down).

### 3.2 Turn indicator, never blocking

From the `clock` message (`acted`, `waiting`, `deadlineInMs`): a pill under the top bar, shown only
when this player is in a party of 2+ and some active player has not acted: "2 of 3 acted" and a thin
bar draining over `deadlineInMs`. After this player acted it reads "Waiting for Kari" for at most the
deadline; keys and taps still work (the new input replaces the queued one, the server keeps the
latest). Nothing in the client ever waits on the clock: no modal, no input lock. Phones: "2/3" with
the bar, no names. i18n: `party.acted` (`{acted} of {total} acted`), `party.waitingFor`.

### 3.3 Per-player view

Fog, the exit marker and compass, interact hints, ranged targets, `persuadeOdds` in the dialogue and
the HUD all come from `view` (§1.3), so they are this player's. Log lines stay the shared engine log
(it names who did what). The narration card for an area appears for everyone (the server's GM entry);
the GM's own fog is still the lead's (MP4).

### 3.4 Down players and the spectator camera

`me.down` set → the renderer and PartyOverlay switch to `cameraState = perspective(state, followed)`:
the nearest standing teammate by path, kept until they go down or leave; `Tab` / `‹ ›` on the
spectator pill ("Watching Kari") cycles. The HUD stays this player's, with a card "You are down. You
get up in {n} turns, or sooner when a teammate stands next to you" (`n` = `REVIVE_SELF_TURNS` −
(`turn` − `down.since`), exported from the engine index if it is not yet), the hotbar dimmed, chat,
emotes and pings working. Getting up → camera back with a short tween. A teammate who is down gets a
pulsing "help" ring under them on every screen (they need someone next to them).

### 3.5 Exit countdown

`state.area.exitCountdown { turnsLeft, by }` → a banner over the top bar on every screen: "Kari took
the exit: the party moves on in {n}" (`party.exitCountdown`), ticking with each turn (the server
paces them at ~1 s, so turns read as seconds). The player who took it sees "Waiting for the party:
{n}". No button, nobody waits at the door; the area change rebuilds as today.

### 3.6 Away and left teammates, reconnect

Roster `presence` `off` → name tag dimmed "away", toast once; `gone` (2-minute rule, `leave` entry)
→ chip greyed "left", toast `party.left`; `back` / `return` → toast `party.back`. This client's own
connection: `RoomClient` status `reconnecting` → a non-blocking banner "Reconnecting…" (input queued
nowhere: `act` toasts `room.offline` while not joined); after 20 s it adds "Leave room". `joined`
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
  "use next to you" moves from Enter to Shift+Enter (bump and click still use; the key help and the
  interact hint say so). `/` also opens the input.
- **Phones**: an always-visible round chat button (bottom right, above the hotbar, unread badge)
  opens a bottom sheet: history, input, the emote row and ping buttons; off-screen lines also flash
  for 4 s in a one-line ticker under the top bar. The sheet uses `interactive-widget=resizes-content`
  (already set), so the keyboard pushes the sheet, not the map.
- **Keyboard focus**: the input is a real `<input>`, so `isTextTarget` puts every key into the `text`
  layer (no game key fires; `tests/client/input.test.ts` gets the room cases). Closing the input
  returns focus to the canvas host. Typing never sends an `input` (it costs no turn).
- **Typing state**: on the first non-empty `input` event `client.typing(true)`, repeated every 3 s
  while the text changes; `typing(false)` on send, on clearing the field, on blur and on closing.
  Others see a "…" bubble over the typist (or "Kari is typing…" at the foot of the column).
- **Emotes**: six one-tap buttons 👍 😂 😮 ❤️ 👋 ❓ send that emoji as the chat text; a line that is
  exactly one emote renders as a large bubble without a frame. **Pings**: "Follow me", "Wait", "Help"
  send `ping` at the player's own position (one tap, which is what they mean); everyone sees a
  coloured marker with an icon there for 8 s (edge arrow when off screen) and a column line "Kari:
  Follow me" (`ping.follow`, `ping.wait`, `ping.help`).
- **Limits and feedback**: the counter shows from 160 code points, the field stops at 200
  (`maxlength` by code points in the input handler); a send within 1 s of the last shows "Wait a
  moment" under the input and keeps the draft (`chat.slowDown`); `error chat_rate` / `chat_long` from
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
| close 4007 (replaced: another tab) | start page, toast `room.otherTab` |

`GameUi.toast(text, tone, action?: { label, run, sticky? })` gains the optional action; ToastStack
keeps a sticky entry until its button or ✕ is pressed. A test checks that every `NET_NOTICE_KEYS` key
and every new `room.*`, `lobby.*`, `chat.*`, `party.*`, `ping.*` key exists in en and nb with the same
params (the existing i18n test covers this once the keys are in `en.ts`).

New keys (en and nb, about 70): `room.title`, `.create`, `.joinCode`, `.join`, `.rejoin`, `.refresh`,
`.unavailable`, `.noServer`, `.outdatedPage`, `.empty`, `.players`, `.worldInvalid`, `.tooMany`,
`.linkCopied`, `.share`, `.copyLink`, `.leave`, `.offline`, `.reconnecting`, `.otherTab`,
`.worldMismatch`, `.notAllowed`; `lobby.code`, `.phase.*`, `.ready`, `.notReady`, `.readyCount`,
`.start`, `.host`, `.changeWorld`, `.options.*`, `.gmReadsChat`, `.name`, `.colour`, `.defaultName`,
`.joinAs`, `.playAgain`, `.anotherWorld`, `.waitingHost`; `party.acted`, `.waitingFor`, `.joined`,
`.away`, `.back`, `.left`, `.down`, `.watching`, `.exitCountdown`, `.exitWaiting`, `.busy`;
`chat.open`, `.placeholder`, `.send`, `.typing`, `.slowDown`, `.left`, `.emotes`, `.history`;
`ping.follow`, `.wait`, `.help`; `keys.chat`.

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
| `room-session.test.ts` | 3 sessions in one room: each plays its own pid (p2 moves p2, not the lead); the replica is never written (every client's `hashState` equals the server's after 200 entries); dry-run invalid actions are not sent and toast; coalescing (one input per turn, latest wins); travel sends `travel` intents per new turn and stops on a hostile; dialogue history from outcomes; GM entries give intro and area cards; join / away / back toasts; down → followed teammate, back on revive; exit countdown view; reconnect → state rebuilt, no duplicate toasts |
| `session.test.ts` (existing) | unchanged and passing: the refactor keeps single player identical |
| `chat-model.test.ts` | 100-line cap, bubble per speaker and lifetime, emote detection, ping lines, typing set and expiry, 1/s throttle with `waitMs`, code-point counting (emoji count once) |
| `room-api.test.ts`, `room-config.test.ts`, `room-profile.test.ts` | ok / unavailable / timeout / outdated / refused results, endpoint per build, ws URL from http(s), token store prune and drop rules, profile defaults |
| `boot.test.ts` (existing + cases) | `?room=k7qx` → room `K7QX`; an invalid code → start; room wins over `?world=`; saved run kept |
| `input.test.ts` (existing + cases) | room `game` layer: Enter → chat, Shift+Enter → interact, `/` → chat; `text` layer: WASD, digits, Space give no command |
| `room-qr.test.ts` | matrix size and finder patterns for a known link |
| `tests/server/rooms-room.test.ts`, `protocol.test.ts` (+ cases) | `ready`, `profile`, `world`, difficulty option, `ping`, `room` broadcast (§2.7) |

**Browser (Playwright, headed Chromium under xvfb).** All room specs share one config
`e2e/mp/playwright.mp.config.ts`: its own ports (5183 / 8797, so the other specs' dev server and
other agents are not touched), `ANYWORLD_DATA_DIR=.data/e2e-mp-<run>` (removed in global teardown),
`ANYWORLD_TEST_TIMING` (deadline 600 ms, travel 30 ms, countdown turn 150 ms), `ANYWORLD_TEST_SEED`,
`workers: 1`. Pages start with an init script setting `quality: 'low'` and `reduceMotion: true` in
the settings. Tests wait on conditions through the automation handle (`window.__anyworld.room`:
`state()`, `pid`, `hash()`, `n`, `chat()`, `bubbles()`) with `expect.poll`, never on fixed sleeps,
and compare hashes after waiting until all pages report the same `n`.

- **`e2e/mp/mp-exit.spec.ts` (the exit check)**: three contexts in one browser: A desktop 1280×800
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
- **`mp-lobby.spec.ts`**: room list (create, it appears, Join), join by link and by code, name and
  colour uniqueness, ready count, host start, host leaves → B becomes host and starts, server down
  (`page.route` fails `/api/rooms`) → "unavailable" and single player still starts, outdated health →
  Reload, `?room=ZZZZ` → `net.noRoom`, reload in a room → same seat.
- **`mp-chat.spec.ts`**: one browser page plus two `ScriptedClient` teammates (tools/rooms) to save
  browsers: Enter, bubble on screen vs column off screen, typing bubble, emotes, pings, rate feedback,
  200-character stop, phone button and sheet (phone context), keys never move while typing.
- **`mp-party.spec.ts`**: one page plus scripted teammates: name tags and colour rings, party strip,
  turn indicator with an idle teammate (no wait after it goes idle), teammate away and back (the bot
  drops its socket), the exit countdown banner, and the spectator pill when the page's player is
  down: a Hard room (no second chance) with the fixed test seed, the page's player waiting next to the
  first hostile, so the fall is repeatable; the camera must follow the scripted teammate until it
  revives the player. No test-only "make me down" call: the state comes from play. The spectator
  rules themselves are unit-tested in `room-session`.
- the existing specs (`play`, `modes`, `mobile`…) run unchanged against `playwright.config.ts`.

Reliability: fixed seeds and test timing; one browser with three contexts (three WebGL contexts in
SwiftShader are fine at low quality); no assertions on animation frames, only on state through the
handle and on DOM text; every wait bounded; the server and data dir torn down by the config.

## 8. Build plan

Each step ends with `npx tsc --noEmit -p .` clean, its focused tests, the full `npx vitest run`
passing, the golden replay unchanged, single-player e2e smoke (`e2e/play.spec.ts e2e/modes.spec.ts`)
passing, and a commit on `multi`. The engine is not changed (only `REVIVE_SELF_TURNS` may be
re-exported), so the new-player gate is run once at the end as a check.

| Step | Content | Focused tests |
|---|---|---|
| D1 | **Net additions and client plumbing (no UI)**: protocol and server for `ready`, `profile`, `world`, difficulty option, `ping`, `room` (§2.7), `ANYWORLD_TEST_SEED`; `RoomClient` additions; `room/config.ts`, `api.ts`, `profile.ts`; `bootRoute` `room` kind (main.ts treats it as the start page until D3); `qrcode-generator` dependency and `room/qr.ts`; en/nb keys for D1–D4 | `rooms-room` and `protocol` cases, `room-api`, `room-config`, `room-profile`, `boot`, `room-qr`, `i18n` |
| D2 | **Room session core**: `perspective`, the `GameSession` refactor (§1.2, `view`, `absorbStep`, `absorbGm`, `nextTravelAction`), `RoomSession`, `ChatModel`, the in-memory room harness; `GameController` room mode (`ControllerHost.room`, serial sync, entry-driven travel, presence) and `RoomLink`; the automation handle `__anyworld.room` | `room-perspective`, `room-session`, `chat-model`; `session.test.ts` and all client tests unchanged |
| D3 | **Start page, lobby, notices**: the "Play together" card (list, refresh, unavailable, outdated, create sheet, join by code), `LobbyScreen` (join step, roster, ready, world picker, options, GM line, share link, QR), `App.openRoom/createRoom/leaveRoom` and the `lobby` screen, end-screen play again, toasts with actions for every notice, reconnect banner; phone layouts | `input` cases, `e2e/mp/mp-lobby.spec.ts` |
| D4 | **In-game party and chat UI**: colour rings (`setPartyColours`), PartyOverlay (name tags, bubbles, typing, pings, teammate arrows), party strip, turn pill, exit-countdown banner, spectator camera and pill, away / left; ChatPanel, phone chat button and sheet, emotes, pings, Enter / `/` / Shift+Enter, focus rules, rate feedback | `e2e/mp/mp-chat.spec.ts`, `e2e/mp/mp-party.spec.ts`, render unit tests for the ring |
| D5 | **Exit check and notes**: in-page autoplay (dev/test builds), `e2e/mp/mp-exit.spec.ts` (3 contexts), fixes it finds; `docs/progress/MP3.md`, plan status; the full gate (typecheck, vitest, golden replay, `--gate --seeds 40`, single-player e2e smoke, all `e2e/mp` specs) | `mp-exit` |

## Constants

Turn pill shown for parties of 2+; renderer backlog snap after 4 batches; room list refresh 15 s;
API timeout 5 s; reconnect banner "Leave room" after 20 s; bubble `4 s + 50 ms/char`, max 10 s, ~28
characters per line, 3 lines; column fades after 20 s, 6 lines; ticker 4 s; ping marker 8 s; typing
refresh 3 s (server expiry 8 s); counter from 160 of 200 code points; send throttle 1 s; tokens kept
for 20 rooms / 7 days; emotes 👍 😂 😮 ❤️ 👋 ❓.
