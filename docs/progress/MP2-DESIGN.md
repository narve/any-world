# MP2 — Room server (design)

Date: 2026-10-28 (revised after three reviews, see "Review notes"). Branch `multi`. Scope:
[MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3 row MP2 with §1, §2, §2.1 and the owner decisions in §6;
builds on [MP1.md](MP1.md) ("Known gaps for MP2"). Server, protocol and engine bits only: no lobby, chat
or multiplayer view in the client (MP3), no AI game master in rooms (MP4). The single-player client plays
exactly as today (it does not use rooms); the golden replay (`tests/engine/golden-replay.test.ts`) and
the new-player gate stay unchanged.

## 1. Module layout

| Path | Content | Runs in |
|---|---|---|
| `src/net/protocol.ts` | zod schemas and types for every message, limits (`LIMITS`), `PROTOCOL = 1`, `peekHello` (lenient), `parseClientMsg` / `parseServerMsg` | client build, server, tests |
| `src/net/log.ts` | `LogEntry` and `applyEntry(world, state, entry)`: the one function that moves a room's state (server, restart replay, clients, tests) | all |
| `src/net/client.ts` | `RoomClient`: socket wrapper with ordering, hash reports, reconnect with token, `worldId` check; takes a socket factory (browser `WebSocket`, or `ws` in Node) | all (MP3 uses it in the browser) |
| `src/net/messages.ts` | `noticeFor(refused \| closed)` → `{ key, reload }` (i18n keys for the MP3 toast) | all |
| `src/net/version.ts` | `ENGINE_VERSION` (build-time constant in the client bundle, §8) | client build, vitest |
| `src/gm/offline.ts` | `OfflineGmDirector`, `gmHooksFor`, `HookTracker` moved from `src/client/gm-director.ts` (no DOM; labels through an injected `t`; `Difficulty` from `src/schema/gm.ts`) | all |
| `server/engine-version.ts` | `computeEngineVersion(root)` (§8) | vite config, vitest config, server start-up, Node tools |
| `server/data-dir.ts` | `resolveDataDir(env, repoRoot)`, `ensureDataDir(dir)` | server |
| `server/rooms/timing.ts` | `RoomTiming` (every duration the rooms use) and `Scheduler` (`now`, `setTimer`, `cancel`; real and manual) | server, tests |
| `server/rooms/room.ts` | `Room`: seats, roster, phases, engine state, turn clock, chat, GM, hash checks | server |
| `server/rooms/clock.ts` | pure `nextResolve(view, now)` (§4) | server |
| `server/rooms/manager.ts` | `RoomManager`: create, list, find, limits, idle sweep, load at start, version closing, shutdown | server |
| `server/rooms/store.ts` | world file, snapshot file, append log, atomic writes, load and replay (§7) | server |
| `server/rooms/ws.ts` | upgrade handling on the `node:http` server, Origin check, per-IP limits, `Conn` | server |
| `server/rooms/worlds.ts` | demo worlds from `content/worlds` (lazy, `parseWorld`, cached by file id) | server |
| `server/rooms/limits.ts` | `TokenBucket` per connection (reuses `RateLimiter` for per-IP keys) | server |
| `tools/rooms/scripted-client.ts` | scripted Node client: `RoomClient` + a sim bot + chat script + `FaultyChannel` (§11) | tests, `tools/room-bots.ts` |

The protocol is shared the way `src/llm` already is: the server imports `src/net` directly through tsx,
Vite bundles it into the client, and both validate with the same zod schemas. `src/net` imports only
`src/engine`, `src/schema`, `src/gm` and zod (no `node:` modules, no DOM, nothing from `src/client`).
`src/client/gm-director.ts` keeps `GmRunner` and re-exports the moved names, so the client code and its
tests do not change.

Dependencies: `ws` 8.22.0 and `@types/ws` 8.18.2 (dev), pinned exactly like the others. Nothing else.

## 2. Protocol

Text frames of JSON, one message each, discriminated by `t`. Incoming frames over 16 KB are refused by
`ws` (`maxPayload: 16384`, `perMessageDeflate: false`); a world (up to ~140 KB today) is uploaded over
HTTP (§3), never over the socket. Every incoming message goes through `parseClientMsg`; invalid or
unknown ones are dropped and counted (`conn.invalid`); 50 invalid messages close the socket (1008).
Outgoing messages are validated in tests only (`parseServerMsg` in the client and the scripted client).

```ts
const Code = z.string().regex(/^[2-9A-HJ-NP-Z]{4}$/);          // room code, no 0/O/1/I/L
const Token = z.string().regex(/^[A-Za-z0-9_-]{22}$/);         // 128-bit, base64url
const Name = z.string().trim().min(1).max(24);                 // control characters stripped first
const Colour = z.enum(PLAYER_COLOURS);                         // 12 fixed colours ('#e6194b'…)
const Intent = z.enum(['decide', 'travel', 'wait']);
const Presence = z.enum(['playing', 'menu']);                  // client view state; a hidden tab is 'menu'
const PlayerActionSchema = z.discriminatedUnion('type', [ … ]); // mirrors engine PlayerAction, ints bounded
```

`tests/net/protocol.test.ts` holds a two-way type check (`z.infer<typeof PlayerActionSchema>` assignable
to `PlayerAction` and back), so a new engine action breaks the build instead of being dropped as invalid.

Client → server:

| `t` | Fields | Limits |
|---|---|---|
| `hello` | `v: 1`, `engine` (≤ 64), `room: Code`, `token?`, `name`, `colour`, `lastN?`, `run?` | first message, within 5 s, else close 4000 |
| `input` | `area` (area index), `turn` (`state.turn` the client decided on), `actions: PlayerAction[]` (≤ 4), `busy?`, `intent` | 20/s, burst 40 |
| `presence` | `state: Presence` | 4/s |
| `typing` | `on: boolean` | 4/s |
| `chat` | `text` (1–200 code points after trim) | 1/s (§5) |
| `hash` | `n`, `h` (16 hex) | 2/s |
| `applied` | `n` (an area-change entry is applied locally, §4) | 2/s |
| `start` | `demo?` (file id) | host only; lobby or ended phase |
| `options` | `deadlineMs?` (1000–5000), `maxPlayers?` (2–12, ≥ seats) | host only |
| `leave` | — | — |

Overall 40 messages/s per connection; a message over a bucket is dropped with a non-fatal `error`
(`rate`), and 200 drops in a minute close the socket (1008). There is no app-level ping: `ws` pings every
15 s detect dead sockets, and nothing in MP2 needs round-trip times.

Server → client:

| `t` | Fields |
|---|---|
| `welcome` | `room: RoomInfo`, `you: { seat, pid \| null, token, host }`, `roster`, `phase`, `run`, `options`, `world?` + `worldId` (the world is omitted when `hello.run` matches and the client has it), `snapshot?: { n, state }` (`serialize`), `entries?: LogEntry[]` (when `lastN` is in the ring buffer), `chat: ChatLine[]` |
| `entries` | `run`, `es: LogEntry[]` (usually one) |
| `snapshot` | `run`, `n`, `state` (desync) |
| `run` | `run`, `world?`, `worldId`, `snapshot` (a new run: "play again") |
| `roster` | `seats: RosterEntry[]` (on change) |
| `clock` | `n`, `acted: PlayerId[]`, `waiting: PlayerId[]`, `deadlineInMs?` (throttled to 5/s; MP3's "2 of 3 acted") |
| `chat` | `line: ChatLine` |
| `typing` | `seat`, `on` |
| `refusal` | `reasons: { action, reason }[]` (to the acting seat only: its inputs the engine refused; nothing was appended) |
| `error` | `code: 'rate' \| 'invalid' \| 'not_host' \| 'chat_rate' \| 'chat_long' \| 'bad_phase' \| 'stale'`, `message` (non-fatal; `stale`: the input was for an older area or turn and was dropped, decide again) |
| `refused` | `code: 'outdated' \| 'no_room' \| 'room_full' \| 'room_closed' \| 'bad_token' \| 'server_full'`, `message`, `reload?: true`, `reason?` (then close 4001–4006) |
| `closed` | `reason: 'server_updated' \| 'idle' \| 'empty' \| 'error'`, `message` (then close 4010) |
| `bye` | `reason: 'restart'` (graceful shutdown; clients reconnect with backoff 0.5–5 s) |

```ts
interface RosterEntry { seat: string; pid: PlayerId | null; name: string; colour: string; host: boolean;
  connected: boolean; presence: 'active' | 'busy' | 'menu' | 'idle' | 'off' | 'gone'; since: number }
interface ChatLine { id: number; seat: string; name: string; colour: string; text: string; at: number }
interface RoomInfo { code: string; world: { id: string; title: string; genre: string; language: string };
  players: number; maxPlayers: number; phase: 'lobby' | 'playing' | 'ended'; joinable: boolean }
```

**Hello, in this order.** (1) `peekHello` reads only `{ t: 'hello', engine: string }` leniently, so a
page from a later or earlier protocol still gets a clear answer; `engine !== server version` →
`refused { code: 'outdated', reload: true }`. (2) Full `parseClientMsg`. (3) Room lookup (tombstone →
`room_closed`, unknown → `no_room`). (4) Token lookup. So a deploy gives an old page one toast,
`outdated`, never `bad_token` or a timeout.

**Join and reconnect.** `hello` without a token takes a new seat (`room_full` when seats = maxPlayers;
a seat whose player left the map still counts, §3). With a token the server finds the seat by
`sha256(token)`; an unknown token is `bad_token` (the client then joins as new). A second socket with
the same token replaces the first, which is closed with 4007 ("replaced": the player opened a new tab).
The token is created at the first join, sent once in `welcome`, kept by the browser (MP3: `localStorage`
per room code) and stored hashed. **Names and colours are unique in a room**: a taken colour is replaced
by the first free one of the 12 (at most 12 seats), and a taken name gets " 2", " 3"…; the roster shows
what the server chose.

**Welcome.** The server builds `welcome` (snapshot or entries from the ring buffer) and adds the
connection to the room's broadcast set in the same synchronous step, so no entry is lost or sent twice.
`lastN` greater than the server's `n` (the client saw an entry the server lost, e.g. after a power loss)
or a different `run` → a full snapshot. `RoomClient` checks `worldIdOf(parseWorld(world).world) ===
worldId` and refuses to play on a mismatch (a test checks that `parseWorld` is idempotent for all 21
worlds, so this never fires in practice).

**Engine version.** Answered as above; the same check answers `POST /api/rooms` with 409 `outdated`. A
room whose stored version differs from the server's is closed at start-up (§7) and a token for it gets
`refused { code: 'room_closed', reason: 'server_updated' }`. `noticeFor` maps `refused outdated` →
`net.outdated` (with reload: true) and `closed server_updated` / `room_closed server_updated` →
`net.serverUpdated`; the en/nb strings land in MP2 and are unit-tested, and the exit checks assert the
keys. The toast itself is MP3, with a reload **button** only (never an automatic reload: Pages and the
server deploy at different times, and an automatic reload would loop while Pages still serves the old
build).

## 3. Room lifecycle

HTTP routes in `server/app.ts` (CORS as for `/api` today; every token travels in a JSON body, so the
preflight needs no new header):

- `GET /api/rooms` → `{ rooms: RoomInfo[], max: 10 }` (open rooms, newest first; 60/min per IP).
- `GET /api/rooms/:code` → `RoomInfo` or 404 (the `?room=K7QX` link lands here first).
- `POST /api/rooms` `{ engine, demo? | world?, options?: { maxPlayers, deadlineMs, difficulty } }` →
  201 `{ code, token }`. Body ≤ 1 MB; an uploaded world goes through `parseWorld(json, { strictKeys:
  true })` and is refused (400 with the first 5 errors) when invalid; `demo` must name a file in
  `content/worlds`. 6 room creations per IP per 10 min, invalid uploads included; 503 `server_full` at 10
  rooms. The token is the creator's seat (the host); they then connect with `hello { token }`.
- `POST /api/rooms/:code/world` `{ token, world }` (host only, lobby or ended phase) → a new uploaded
  world for "play again".
- `/api/ws`: the WebSocket upgrade (§9). The dev proxies (`vite.config.ts`, `server/dev.ts`) get
  `ws: true`.

**Phases.** `lobby` (created; seats join; a seat disconnected for 2 minutes in the lobby is removed, it
has no character yet) → `start` by the host creates the run with every seat in the lobby,
`createGame({ seed, players, difficulty, exitCountdownTurns: EXIT_COUNTDOWN_TURNS })`, seed from
`crypto.randomInt`; a seat that is off at start gets its character and the 2-minute rule below → `playing`
→ `ended` (state status `won` / `lost`). In `ended` the host sends `start { demo? }` (or uploads a world
first): a new run (`run + 1`, new seed, new log, `n = 0`) with every seat that is connected or off for
less than 2 minutes; others lose their seat. Entries carry their `run`, so a late message from the old
run is dropped.

**Late join** (phase `playing`): a new seat gets a `join` entry; `addPlayer(state, { name, near })`
places them next to the host's character (`near` = the host's pid when it is on the map, else the lead);
`welcome` brings the snapshot after it.

**Disconnect and the 2-minute rule** (`timing.awayMs = 120 000`):

1. The socket closes (or misses two `ws` pings, 15 s apart): the seat is `off`; the server appends
   `{ k: 'away', pid }` (engine `setAway`, §10a): hostiles leave the character alone for
   `BUSY_MAX_TURNS` turns from when it went away (`awaySince`; the plan's "the 10-turn cap applies");
   it never counts as active (§4).
2. Reconnect within 2 minutes with the token: the 2-minute timer is cancelled first, then the seat is
   bound; a `back` entry (unless the seat has already left the map, checked by `seat.leftAt`, not by
   timer order); `welcome` with the missing entries or a snapshot.
3. After 2 minutes away: a `leave` entry, engine `leaveMap` (§10a): the character leaves the map, its
   items drop where it stood; the seat is `gone` but kept (counts against maxPlayers) until the run ends.
   Reconnecting later appends a `return` entry (`returnToMap`, next to the host as for a late join).
4. A `leave` message counts as a disconnect at once (the same 2 minutes; leaving is not a punishment).
5. Nobody leaves the map while no seat is connected (an empty room sleeps: no timers at all, §4), while
   every other party member is down (that would end the run), or when they are the last party member. The
   2-minute timer is then re-armed when the condition clears.

Every close and timeout handler checks `seat.conn === thisConn` before it changes the seat, so the late
`close` of a replaced socket does nothing.

**Host hand-over**: when the host's socket closes, the connected seat with the oldest `connectedSince`
becomes host (`roster` broadcast); a returning ex-host does not take it back. No kicking.

**Closing**: idle 2 h (no input and no chat; `timing.idleCloseMs`, swept every minute) → `closed {
reason: 'idle' }`; every seat has sent `leave` or is `gone` → `closed { reason: 'empty' }`; an
engine-version change at start-up → `server_updated` (§7); an engine exception → `error` (§9). A party
that all close their laptops for lunch keeps its room (until the 2-hour idle rule). A closed room's files
are removed, its uploaded world is dropped from the engine registry (`unregisterWorld`, new, a no-op for
demo worlds still in use), and its code kept in a tombstone file for 7 days so tokens get `room_closed`
rather than `no_room`.

## 4. The turn clock

```ts
/** src/net/log.ts — the room's state only ever moves through these (n counts entries, from 0 per run) */
type LogEntry = { n: number; run: number } & (
  | { k: 'turn'; inputs: TurnInput[]; advance: boolean }        // engine stepTurn
  | { k: 'gm'; hook: GmHook; actions: GmAction[] }              // engine applyGmActions
  | { k: 'join'; seat: string; name: string; pid: PlayerId; near: PlayerId }  // addPlayer (pid checked)
  | { k: 'away' | 'back'; pid: PlayerId }                       // setAway
  | { k: 'leave'; pid: PlayerId }                                // leaveMap
  | { k: 'return'; pid: PlayerId; near: PlayerId });             // returnToMap
export function applyEntry(world: WorldSpec, state: GameState, e: LogEntry): { state: GameState; events: GameEvent[] };
```

The server applies an entry, **appends it to the log (`appendFileSync`), then broadcasts it**; clients
apply the same entries in order with the same function (lockstep; a few hundred bytes per entry). The
server is the authority. An entry whose result is the same state object (every action refused, a busy
flag already set) is neither appended nor broadcast; the acting seat gets `refusal` instead.

**Inputs.** An `input` whose `area` is not the current area index, or whose `turn` is more than
`STALE_TURNS = 3` behind `state.turn`, is dropped with `error stale` (measured in engine turns, not
entries, so typing, presence and free-action entries never make an honest client stale). Otherwise it
splits into its free actions (talk, choose_option, choose_perk, toggle_sneak), appended at once as their
own `turn` entry with `advance: false` (they never move the world, so nobody waits for them), and at most
one turn action, kept as the seat's pending input for the next turn (latest wins). `busy` alone is a
`turn` entry too. A pending input from a player who is not engine-ready (slower than the others) stays
pending until a turn where they are; its deadline start is reset to the resolve that carried it over.
Every entry that changes `state.area` clears all pending inputs and `firstAt`.

**Active players** (`activeIds`): engine `readyPlayers(state)` ∩ seats that are connected, `presence:
'playing'`, not typing, without an open `pendingChoice` (dialogue, trade, offer), and with an input or
presence change in the last 10 s (`timing.idleActiveMs`). Everyone else is inactive and never holds up a
turn.

```ts
interface ClockView { active: PlayerId[]; ready: PlayerId[];
  pending: Map<PlayerId, { intent: Intent; at: number; ready: boolean }>;
  firstAt: number | null; lastResolveAt: number; deadlineMs: number; countdown: boolean;
  areaHoldUntil: number | null; anyConnected: boolean; wakes: number[] }   // wakes: idle, typing, away, hold, hello timers
/** server/rooms/clock.ts: when the next turn resolves, and when the room must look again */
export function nextResolve(v: ClockView, now: number):
  { resolve: { at: number; advance: boolean } | null; wakeAt: number | null };
```

Rules, in order:

0. **Nobody connected**: nothing resolves and no timers run (an empty room sleeps, countdown included).
1. **Exit countdown** (`state.area.exitCountdown` set): turns resolve every `timing.countdownTurnMs =
   1000` (`at = lastResolveAt + countdownTurnMs`, `advance: true`), whether or not anyone acted. Rooms
   create their runs with `EXIT_COUNTDOWN_TURNS = 10` (a constant, not derived from the timing, so the
   fast test timing keeps 10). The engine counts the countdown in world rounds (`tickExitCountdown` in
   `endRound`), not party turns, so with slow, hasted or stunned players "10 turns ≈ 10 s" is approximate
   (up to ~20 s); accepted.
2. **Area hold**: after an entry that changed area (map generation, up to ~0.6 s on the server and on
   each client), `areaHoldUntil = min(all connected seats sent applied {n}, resolvedAt + 3000)`; no
   deadline starts before it. The generation time counts against nobody.
3. **Everyone active has acted** (true when the active set is empty) and some input is pending:
   - some pending input is from a ready player: if any pending intent is `decide`, resolve now; if all are
     `travel` / `wait`, at `lastResolveAt + timing.travelMs (100)`. `advance: false`.
   - no pending input is from a ready player (the only ready players are inactive, or the pending ones
     are slow): resolve at `lastResolveAt + travelMs` with `advance: true`, so the world runs until the
     waiting players are ready. This also covers a party of one left by `leaveMap` with energy below 100.
4. **Deadline**: some input is pending and someone active has not acted: resolve at `firstAt +
   deadlineMs` (room option, 1–5 s, default 2 s) with `advance: true` (ready players without input
   wait). `firstAt` is when the first pending input arrived, but not before `areaHoldUntil`.
5. **No input pending** (outside a countdown): no resolve. While nobody acts the world does not move.

`wakeAt` is the earliest of `wakes`: the 10 s step to idle, the 8 s typing expiry, the 2-minute away
timers, the end of the area hold, the `hello` timeout. These change the active set without any message,
so the room re-evaluates then too. The room is driven by an injected `Scheduler` and keeps one timer for
`min(resolve.at, wakeAt)`; it re-evaluates on every input, presence, typing, connect/disconnect and timer
and resolves with `applyEntry({ k: 'turn', inputs: pending, advance })`. `lastResolveAt` is taken after
the step, so a slow step (area entry) shortens nobody's next deadline. `clock` messages tell clients who
has acted and the deadline left.

**After each turn entry** the server checks for GM moments (§6), for run end (phase `ended`, snapshot),
for an area change (snapshot, area hold, pending cleared), and re-appends `busy: true` for a typing seat
whose own turn action cleared `busySince`.

**Desync guard.** Clients send `hash { n, h: hashState(state) }` after every entry with `n % 10 === 0`.
The server keeps its own hashes for the last 64 such `n` (computed when the entry is applied) and the last
512 entries in a ring buffer (for `welcome` after a reconnect). A mismatch sends that client a `snapshot`
and is logged (`[room K7QX] desync seat s2 at n=340`). There is no gap sync: one WebSocket is ordered and
lossless, so a gap can only follow a reconnect, which `welcome` with `lastN` covers; a client that still
sees a gap (a bug) closes and reconnects.

## 5. Chat

`chat { text }`: control characters stripped, trimmed, 1–200 code points (`chat_long` otherwise), at
most 1 message/s per seat (`chat_rate`). The server stamps `{ id, seat, name, colour, text, at }`,
appends it to the room's history (ring of `CHAT_HISTORY = 100`, persisted, §7; kept across runs so the
MP4 game master can read it) and broadcasts it to every connected seat. Chat never touches the engine
and never costs a turn.

`typing { on: true }` broadcasts `typing` and appends a `busy: true` turn entry (the seat becomes
inactive and busy for hostiles, capped at `BUSY_MAX_TURNS` by the engine, as in MP1); `on: false`, a sent
chat line, or 8 s without a refresh (clients repeat `on: true` every 3 s while typing) ends it with
`busy: false`. Speech bubbles, the side column and emotes are MP3; pings and emotes reuse `chat` in MP3.

## 6. Canned GM lines in rooms

`OfflineGmDirector`, `gmHooksFor`, `HookTracker`, `eventFlag` and friends move to `src/gm/offline.ts`
unchanged in behaviour. `Difficulty` comes from `src/schema/gm.ts`, `leadPlayer` from the engine, and the
one i18n use (offer labels) becomes an option: `new OfflineGmDirector({ t })`; the client passes its `t`,
the server a lookup in the world's language catalog (`en.ts` / `nb.ts` with `message-format.ts`, no
other client code).

Per room: a `HookTracker` (persisted with the snapshot) and one director. After every `turn` entry:
`hooks = gmHooksFor(world, before, after, events, tracker)`; each hook → `director.respondSync(...)`;
a non-empty response is appended as a `gm` entry (sanitized with `sanitizeResponse`), so clients and
restart replays apply it as data and never run the director themselves. The `intro` hook is asked at run
start. As in MP1, GM actions target the lead player, and `boss_seen` / `npcLine` read only the lead's fog
(the lead changes when it leaves the map); MP4 makes the GM party-aware and swaps the director for the AI
one behind the same interface. On replay the tracker is rebuilt by calling `gmHooksFor` again over the
replayed entries, without asking the director (deterministic).

## 7. Persistence

`resolveDataDir`: `ANYWORLD_DATA_DIR` if set; else `STATE_DIRECTORY` (systemd sets it from
`StateDirectory=anyworld`, i.e. `/var/lib/anyworld`); else `.data/` in the repo (gitignored). It does not
look at `NODE_ENV` (`npm start` sets `production` on the laptop too). `deploy/anyworld.env.example` sets
`ANYWORLD_DATA_DIR=/var/lib/anyworld` explicitly. `ensureDataDir` makes `<dir>/rooms` (recursive) and
writes and removes a probe file; on failure `main()` prints `[server] cannot use data directory <dir>:
<error>` and exits 1 (systemd shows it). Rooms are on when `startServer` gets `rooms` (from `main()` and
`dev.ts`, or tests with a temp dir); existing server tests that do not pass it run without rooms and
create no files.

Files per room, all written only by the room; every rewrite is atomic (write `*.tmp`, fsync, rename):

```ts
/** rooms/<code>.world.json — written when a run starts with a new world, never otherwise */
interface WorldFile { format: 1; worldId: string; world: WorldSpec; source: { demo: string } | { upload: true } }
/** rooms/<code>.json — the small part, rewritten at each snapshot */
interface RoomFile { format: 1; code: string; engineVersion: string; createdAt: number; updatedAt: number;
  options: RoomOptions; phase: Phase; run: number; seed: number; seats: SeatRecord[];
  snapshot: { n: number; state: string } | null;  // serialize()
  hooks: HookTracker; chat: ChatLine[] }
interface SeatRecord { seat: string; tokenHash: string; name: string; colour: string; pid: PlayerId | null;
  joinedAt: number; left?: boolean }
```

`rooms/<code>.log` — newline-delimited JSON, appended (`appendFileSync`, one write call per line, so a
`kill -9` cannot cut a line; only a power loss can tear the last one) for every entry and every new seat
or chat line: `{ e: LogEntry }`, `{ seat: SeatRecord }`, `{ chat: ChatLine }`. A new snapshot (every 100
entries, after an area change, at run start and end, at graceful shutdown) rewrites `<code>.json` (state
only, tens of KB) and then truncates the log; on load, log entries with `n ≤ snapshot.n` or another
`run`, duplicate seats and chat ids, and a torn last line are skipped, so a crash between the two steps is
harmless.

**Start-up**: `RoomManager.load()` deletes leftover `*.tmp` files, then reads every `rooms/*.json` (and
its world file): wrong `format` or unreadable → moved to `rooms/broken/` with a log line (never fatal);
`engineVersion` differs → the room is closed: files removed, code added to `rooms/closed.json` (`{
[code]: { reason: 'server_updated', at } }`, written atomically, pruned after 7 days); otherwise
`parseWorld` (the stored world is treated as untrusted too), `deserialize` the snapshot, replay the log
with `applyEntry` (≤ 100 entries, a few ms), rebuild the GM tracker, all seats `off`. The room sleeps
(no timers, §4) until a seat reconnects; then the away timers of the other seats start.

**Shutdown** (SIGTERM/SIGINT in `index.ts` and `dev.ts`): every room snapshots, every socket gets `bye`.

## 8. Engine version

`computeEngineVersion(root)`: the git-tracked `*.ts` files (`git ls-files`; a directory walk of `*.ts`
when git is not there) under `src/engine`, `src/schema` and `src/net`, leaving out `src/engine/sim/`,
`src/engine/balance/` (bots and static balance: not loaded by the runtime engine) and
`src/net/client.ts`, `src/net/messages.ts` (no effect on lockstep). Sorted by relative path (`/`
separators), each fed to sha256 as `path \0 content \0` with CRLF normalised to LF; the first 16 hex
characters. No hand-kept number; `applyEntry` and the protocol count as engine.

- **Client**: `vite.config.ts` calls it and defines `__ANYWORLD_ENGINE_VERSION__` (both modes, so the
  Pages build carries it); `vitest.config.ts` defines it the same way; `src/client/globals.d.ts`
  declares it; `src/net/version.ts` exports `ENGINE_VERSION` (`typeof … !== 'undefined'` guard, else
  `'dev'`). Only bundled code reads this constant.
- **Server and Node tools**: never read `ENGINE_VERSION`. `main()` computes the version once at start-up
  from the deployed checkout and passes it as `AppOptions.engineVersion`; `tools/room-bots.ts` and the
  scripted client call `computeEngineVersion` themselves (or take `--engine`). `ANYWORLD_ENGINE_VERSION`
  overrides the computed value, honoured only when `NODE_ENV !== 'production'`, for the child-process
  tests. `/api/health` reports it (`engine`), which the deploy check prints.
- Tests: the vitest define and the server computation agree; `room-bots` joins a server started as a
  child process (outside vitest).
- HOSTING.md: deploy the Pages build and the server together; in dev the version is computed when Vite
  and the server start, so after editing the engine restart both (else the page is refused as outdated).

## 9. Security

- **Origin**: every upgrade on `/api/ws` must carry an `Origin` that is in `ALLOWED_ORIGINS`; else 403
  before the upgrade. Only when the list is empty (dev) is the request's own `http(s)://<Host>` allowed
  too (the page served by this server, or the Vite proxy). A missing Origin is refused (tests send one).
  Upgrades on other paths get 400 and the socket is destroyed; `socket.on('error')` is attached before
  `handleUpgrade`.
- **Validation**: every message through zod (§2), with bounded strings, arrays and integers; actions use
  `PlayerActionSchema`, and the engine still refuses what is not possible ('illegal' outcomes are counted
  per seat and logged above 20 per minute). Uploaded worlds: content-type JSON, ≤ 1 MB, `JSON.parse`
  with the existing depth guard (`src/schema/json-depth.ts`), `parseWorld` with strict keys; then
  `createGame` in a try/catch and timed: a world whose first area takes over 2 s is refused (400). Later
  slow areas are only logged (a worker thread is a possible improvement, not MP2). Names and chat lose
  control characters; colours are a fixed list.
- **Sizes**: `maxPayload` 16 KB on the socket; HTTP bodies 1 MB for rooms (the 4 MB limit stays for
  `/api/llm`); a socket whose `bufferedAmount` exceeds 4 MB is closed (1009).
- **Rate limits**: per connection, token buckets per message type and overall (§2); per IP (with
  `clientIpFrom`, on upgrades too): 20 upgrades/min, 16 open sockets, 6 room creations per 10 min, 60 list
  calls/min; 200 sockets in all. The per-IP numbers are injectable (`startServer({ rooms: { limits } })`).
  Behind Caddy every player shares the proxy's IP, so `TRUST_PROXY=1` is a required production setting
  (HOSTING.md, `deploy/anyworld.env.example`). `hello` within 5 s; `ws` pings every 15 s.
- **Room limits**: 10 rooms (`ANYWORLD_MAX_ROOMS`), 8 players by default, the host may set 2–12; idle
  close after 2 h. Room codes are not secret (rooms are public, owner decision); seat tokens are 128-bit
  random and stored as sha256 hashes.
- **Isolation**: a room's engine call that throws is caught; the room is closed with a log line and a
  `closed { reason: 'error' }`, the process and other rooms go on.
- **Shutdown of sockets**: `startServer().close()` terminates every `ws` client before `server.close()`
  (`closeAllConnections` does not reach upgraded sockets).

## 10. Engine changes

**a. Away, leaving and returning** (`src/engine/index.ts`, core in `party.ts`):

```ts
/** marks a player away (disconnected) or back. Away: hostiles never pick it as a target (isBusy with no
 *  turn cap). Pure; a no-op in a party of one, so solo saves and hashes are unchanged. */
export function setAway(state: GameState, pid: PlayerId, away: boolean, env?: EngineEnv): StepResult;
/** the player's character leaves the map: items drop where it stood (pack and equipment), its dialogue
 *  ends, hostiles drop it as a target, its allies follow the lead; it leaves `party` but stays in
 *  `players` with `left: { turn, hp }`. Pure. Throws for the last party member, and when every other
 *  party member is down (that would end the run). */
export function leaveMap(state: GameState, pid: PlayerId, env?: EngineEnv): StepResult;
/** back next to `near` (as addPlayer): the hp it left with (at least 1), level, xp, perks and knowledge
 *  kept, an empty pack (its items lie where it left them), fresh fog */
export function returnToMap(state: GameState, pid: PlayerId, opts: { near: PlayerId }, env?: EngineEnv): StepResult;
/** addPlayer gains an optional anchor: next to `near` instead of the lead */
export function addPlayer(state: GameState, opts: { name: string; near?: PlayerId }, env?: EngineEnv): …;
```

`PlayerState.away?` and `left?` are optional and absent in single player, so saves and hashes of a party
of one are unchanged (`hashState` already walks players outside `party`). Returning with an empty pack
and the old hp means leaving for 2 minutes neither heals nor hands the party a fresh starting kit.
`moveOn` already falls back to the lead when the countdown's `by` is gone; `checkEnd` runs after all of
them. `area.partySize` is fixed when an area is entered, so late joiners and leavers rescale hostiles and
bosses only from the next area.

**b. Bosses scale with the party.** Today a unique hostile's hp scales with `PARTY_SCALING.uniqueHp`
(0.5) instead of `hostileHp`. MP2 adds, for parties of 2+ only (`n > 1`, so single player and the golden
replay are unchanged):

- `PARTY_SCALING.uniqueHp` 0.5 → 0.8 (a boss faces the whole party's focus fire);
- new `PARTY_SCALING.uniqueDamage = 0.1`: damage a unique hostile deals ×`partyFactor(n, 0.1)`, in
  `combat.ts` next to the band's `hostileDamage` (n = `area.partySize`).

The numbers are a starting point, tuned in step C1 with `tools/sim.ts --party-sizes 2,3,4` (a new
`bossRounds` column in the party summary: rounds from a boss's first sight to its death): boss fights
should last about as many rounds per player as in single player, with **fell** staying within a few
points of MP1's 19–24 %. `tests/engine/party-scaling.test.ts` and the MP1 party-sim assertions are
updated where they read the old factor, and the C1 commit records the new baseline. `balance/static.ts`
(single player) is untouched.

**c. Exit countdown**: no engine change; rooms pass `exitCountdownTurns: EXIT_COUNTDOWN_TURNS` (10).

**d. Registry**: `unregisterWorld(id)` so a closed room's uploaded world does not stay in memory.

## 11. Scripted client and exit-check tests

`tools/rooms/scripted-client.ts` (under `tools/`, since `tools/room-bots.ts` imports it and it uses `ws`):

```ts
interface ScriptedOptions { url: string; origin: string; room: string; name: string; colour: string;
  token?: string; engine: string;                  // computeEngineVersion(root), or 'old' for the outdated test
  bot?: BotName;                                   // decides on the client's own replica (sim bots)
  chatEvery?: number;                              // a chat line every k entries
  fault?: { delayMs?: [number, number]; stallEvery?: number; stallMs?: number; closeEvery?: number;
            dropInputs?: number; seed: number } }
class ScriptedClient { connect(): Promise<Welcome>; state: GameState; pid: PlayerId; n: number;
  chats: ChatLine[]; refusals: Refused[]; notices: Notice[]; desyncs: number; reconnects: number;
  play(entries: number): Promise<void>; drop(): void; reconnect(): Promise<Welcome>; close(): Promise<void> }
```

It wraps `RoomClient` with a `ws` socket factory. The bot sends one turn action per ready turn with
`intent: 'decide'` (so turns resolve on round-trips, not deadlines), free actions as they come, and
`typing` before each chat line. `FaultyChannel` models what WebSocket over TCP really does: a seeded
delay with jitter on every frame (order kept), stalls (no frames for `stallMs`, then a burst), random
socket closes followed by a reconnect with `lastN`; and it drops a share of outgoing inputs (a lost input
behaves like a late one and exercises the deadline). `tools/room-bots.ts --url … --room … --bots 4` runs
the same clients against a live server by hand.

**Timing in tests.** `RoomTiming` is injected through `startServer({ rooms: { dataDir, timing,
scheduler, engineVersion, limits } })`, never through the protocol (the zod bounds stay 1000–5000 ms).
Socket tests use deadline 300 ms, travel 20 ms, countdown turn 50 ms; the child-process server reads
`ANYWORLD_TEST_TIMING` (JSON) and `ANYWORLD_ENGINE_VERSION`, both honoured only when `NODE_ENV !==
'production'`, and prints `listening <port>` on stdout. Room-level tests use a manual `Scheduler`
(`advanceTo(t)`), not `vi.useFakeTimers` (which fights `ws`).

Exit checks, all in `tests/server/rooms-exit.test.ts` (one file, `describe.sequential`, its own
`testTimeout`, server on port 0 with a temp data dir, `fixture-western`; child servers killed by PID in
`afterEach`, also when a test fails):

| Case | Checks |
|---|---|
| play | 4 clients join, the host starts, ~150 entries with chat every 25: every client's `hashState` equals the server's, no desync snapshots, chat history identical and in order (≤ 100), typing produced busy entries, a GM `intro` / `area_enter` entry arrived, at least one area change |
| restart | a child process (`tsx server/index.ts`, `PORT=0`) is `SIGKILL`ed mid-run, restarted on the same data dir; the clients reconnect with their tokens, get the missing entries or a snapshot, play 50 more entries and agree on the hash; the log replay is checked against an uninterrupted run of the same entries |
| version | restart with another `ANYWORLD_ENGINE_VERSION`: the room files are gone, reconnects get `room_closed / server_updated` and `noticeFor` gives `net.serverUpdated`, `/api/rooms` is empty |
| outdated | `hello { engine: 'old' }` (also with an otherwise invalid `hello`) → `refused outdated, reload: true`, `noticeFor` gives `net.outdated` with reload; `POST /api/rooms` with an old engine from a listed origin → 409 |
| reconnect | a client drops: roster `off`, an `away` entry, turns go on without waiting for it, hostiles do not target it; reconnect: same pid, `back` entry |
| faults | 4 clients with delay 20–250 ms, stalls, random closes and 5 % dropped inputs, ~100 entries: no crash, every client ends on the server's hash (snapshots allowed and counted), the deadline resolved turns that lost inputs |
| bots | `tools/room-bots.ts` against a child-process server (version from `computeEngineVersion`, not `'dev'`) joins and plays |

The 2-minute path (leave entry, items on the floor, seat `gone`, `return` with empty pack and old hp,
no leave while the room is empty or the others are down) is checked in `rooms-room` with the manual
clock, not over a socket.

Focused unit tests: `tests/net/protocol.test.ts` (every message parses, bounds, unknown `t`, sizes,
`peekHello`, the `PlayerAction` type check), `tests/net/log.test.ts` (`applyEntry` replay equals the
direct engine calls; a `runParty`-style loop through entries ends on the same hash; `parseWorld` is
idempotent and `worldIdOf` stable for all 21 worlds), `tests/net/messages.test.ts` (`noticeFor`, en/nb
keys), `tests/server/rooms-clock.test.ts` (`nextResolve` table: all acted, travel cadence, deadline, idle
and busy players, empty active set, only inactive or slow players ready, carried-over input deadline,
countdown, countdown with nobody connected, area hold, nothing pending, `wakeAt`),
`tests/server/rooms-store.test.ts` (atomic write, world file written once, torn last line, snapshot then
truncate, broken file, leftover tmp, tombstones), `tests/server/rooms-limits.test.ts` (Origin in prod and
dev, bad path, frame size, backpressure, rates, room/IP limits, invalid uploads counted, invalid counts,
`TRUST_PROXY` on upgrades), `tests/server/rooms-room.test.ts` (Room with fake connections and the manual
scheduler: seats, unique names and colours, lobby seat removal, host hand-over, replace race, phases,
play again, chat rules, stale inputs, pending cleared on area change, no-op entries not appended, the
2-minute rule), `tests/engine/party-away.test.ts` (`setAway`, `leaveMap`, `returnToMap`, `near`),
`tests/engine/party-bosses.test.ts`.

## 12. Build plan

Each step ends with `npx tsc --noEmit -p .` clean, its focused tests, the full `npx vitest run`
passing, the golden replay unchanged, and a commit on `multi`.

| Step | Content | Focused tests |
|---|---|---|
| C1 | **Engine**: `setAway` (isBusy without cap), `leaveMap` / `returnToMap` (§10a, empty pack, old hp, not while the others are down), `addPlayer` `near`, `unregisterWorld`; boss scaling (§10b) with the sim `bossRounds` column, tuning and updated party-scaling asserts; `src/gm/offline.ts` moved out of the client (`Difficulty` from `src/schema`) with re-exports (§6) | `party-away`, `party-bosses`, `party-scaling`, the client GM tests unchanged; `--party-sizes 2,3,4 --seeds 10` (0 crashes, fell within a few points of MP1, baseline in the commit), `--gate --seeds 40` passes on all 21 worlds |
| C2 | **Shared net**: `ws` dependency; `computeEngineVersion` (§8) for vite, vitest, the server and Node tools, `/api/health.engine`; `src/net/protocol.ts` (with `peekHello`), `src/net/log.ts`, `src/net/version.ts`, `src/net/messages.ts`; en/nb strings | `protocol`, `log`, `messages`, version agreement test |
| C3 | **Room core**: `server/rooms/timing.ts` (`RoomTiming`, real and manual `Scheduler`), `clock.ts`, `room.ts` (seats, roster, phases, turn clock with wakes, chat, typing, GM entries, hashes, away and 2-minute rule, host hand-over), `store.ts` (world file + snapshot file + log), `worlds.ts`, `manager.ts` (limits, idle sweep, load and replay, version closing with `engineVersion` as a constructor argument); transport-agnostic (`Conn` interface) | `rooms-clock`, `rooms-room`, `rooms-store` |
| C4 | **Network**: `server/rooms/ws.ts` on the existing server (Origin, per-IP and per-connection limits, backpressure, pings, `hello` order and timeout, terminate on close), HTTP routes in `app.ts`, `data-dir.ts` and start-up failure, test env knobs, shutdown, dev proxies with `ws: true`; `src/net/client.ts` (`RoomClient`); `.gitignore` `.data/`; HOSTING.md and `deploy/anyworld.env.example` (`ANYWORLD_DATA_DIR`, `ANYWORLD_MAX_ROOMS`, `TRUST_PROXY=1`, deploy Pages and server together) | `rooms-limits`, a smoke join over a real socket, existing `server` tests unchanged |
| C5 | **Scripted client and exit checks**: `tools/rooms/scripted-client.ts`, `FaultyChannel`, `tools/room-bots.ts`; `tests/server/rooms-exit.test.ts` (§11); `docs/progress/MP2.md` (the toast itself is MP3); plan status | `rooms-exit`; then the full suite and the gate |

### C1 as built

- **API** (`src/engine/index.ts`, core in `party.ts`): `setAway(state, pid, away, env?)` returns
  `state` itself when nothing changes (party of one, a pid outside the party, the flag already as
  asked, run over), so the room can skip no-op entries by identity. `leaveMap(state, pid, env?)` and
  `returnToMap(state, pid, { near? }, env?)` throw on refusal (`the last party member cannot leave`,
  `every other party member is down`, `no player "pN" on the map`, `has not left the map`, `the party
  is full`, `the run is over`); the room checks first (or catches). `addPlayer(state, { name, near? })`;
  `near` that is not a party member on the map falls back to the lead. `unregisterWorld(id)` returns
  whether it was registered. Shared placement: `spotNear` in `party.ts`.
- **Deviation:** `PlayerState.left` is `{ turn, actor }` (the whole actor as it left, without statuses,
  temporary mods or energy) instead of `{ turn, hp }`, so level-up hp, perk stats and the actor id come
  back with it; the hp it returns with is `max(1, actor.hp)`. A left player's `seen` is an empty array
  (also after `deserialize`, so hashes of a loaded snapshot agree). It returns at the end of the party
  order with energy 100 and fresh fog. Leaving also clears `away`, `busySince`, `down` and sneaking;
  a down player may leave while someone else stands. An exit countdown started by the leaver passes
  to the new lead.
- **isBusy**: `ps.away` makes a party member busy for `BUSY_MAX_TURNS` from `awaySince` (still not when down, never in a
  party of one). Away does not change `readyPlayers`: the room's clock decides who it waits for.
- **Invariants** (`sim/run.ts invariantError`) accept players outside the party that have `left`.
- **Boss scaling**: `PARTY_SCALING.uniqueHp` 0.8, new `uniqueDamage` 0.1 in `combat.dealDamage`
  (hostile source with a unique def, target on the player side, `area.partySize > 1`). **Unique NPCs
  (rivals) are left out of the damage factor too**, as they are of the hp factor (`scaledHostileHp`).
- **Sim**: `PartyResult.bossRounds` (per boss killed: rounds from a player first seeing it to its
  death), `PartySummary.bossKills` / `bossRounds`, a `bossRounds(kills)` column.
- **Tuning** (`npx tsx tools/sim.ts --party-sizes 1,2,3,4 --seeds 10 --bots explorer,cautious,talker
  --jobs 15`, 21 worlds, Normal, 210 runs per size). The design's starting numbers held; no further
  change:

  | party | MP1 factors (uniqueHp 0.5): won / fell / downs / bossRounds (kills) | C1 (0.8, damage 0.1) |
  |---|---|---|
  | 1 | 60 % / 6 % / 0 / 11.7 (70) | identical |
  | 2 | 99 % / 20 % / 72 / 15.6 (69) | 99 % / 21 % / 89 / 18.5 (67) |
  | 3 | 100 % / 25 % / 159 / 19.6 (62) | 100 % / 24 % / 146 / 23.8 (60) |
  | 4 | 100 % / 24 % / 248 / 21.5 (63) | 99.5 % / 25 % / 265 / 29.9 (54) |

  0 crashes, 0 stuck, 0 `illegal` refusals, 0 anomalies; fell within one point of MP1. bossRounds runs
  from first sight, so in a party it includes teammates walking over (the bots explore apart): raw
  fight length was already above single player with MP1's factor; per player (bossRounds / n) it
  moves from 7.8 / 6.5 / 5.4 to 9.3 / 7.9 / 7.5 rounds against 11.7 alone. One 4-player run timed out
  (folk-horror-scarecrow-wedding seed 10): the rival NPC Gaffer Hob "backs down" at low hp and the
  bots do not attack a neutral actor the goal needs; he is an NPC, so C1 does not scale him (the run
  diverged by chance). A bot limit, not an engine fault.
- **GM move**: `src/gm/offline.ts` holds the director contract (`GmDirector`, `GmRequest`,
  `GmContext`, `GmHookEvent`, `GmHookDetail`), `OfflineGmDirector({ eventDelay?, t? })` (`t:
  GmTranslate`, keys `gm.offer.take` / `gm.offer.leave`, English without one), `gmHooksFor`,
  `HookTracker`, `newHookTracker`, `IDLE_TURNS`, `FIRST_IDLE_TURNS`, `eventFlag`, `saidFlag`,
  `hashOf`, `responseCost`, `isGmActionType`, `engineQueuedHooks`, `drainEngineQueue`,
  `sanitizeResponse`, `narrationOf`. `src/client/gm-director.ts` keeps `GmRunner` / `GmResult` and
  re-exports the rest; its `OfflineGmDirector` is a subclass passing the client's `t`, so client code,
  `src/llm` and their tests are unchanged. The server (C3) passes a `t` for the world's language.

### C2 as built

- **Dependencies**: `ws` 8.22.0 (dependency, the server needs it at run time) and `@types/ws` 8.18.2
  (dev), exact pins. Nothing uses `ws` yet (C4).
- **Engine version** (`server/engine-version.ts`): `computeEngineVersion(root = REPO_ROOT)` as in §8
  (`git ls-files -z`, a directory walk when git fails, CRLF → LF, `path \0 content \0`, 16 hex);
  `engineFiles(root)` lists what counts. `engineVersionFor(env, root)` is what every caller uses:
  `ANYWORLD_ENGINE_VERSION` (trimmed, ≤ 64) when set and `NODE_ENV !== 'production'`, else the
  computed hash, cached per root. vite.config.ts and vitest.config.ts define
  `__ANYWORLD_ENGINE_VERSION__` with it (imported as `./server/engine-version.js`: Vite's config loader
  warns about imports without an extension, and `.ts` is not allowed by tsconfig); `globals.d.ts`
  declares it. `AppOptions.engineVersion` defaults to `engineVersionFor(env)` inside `createApp`, so
  every server (tests too) reports it as `/api/health.engine`; `main()` computes it once, passes it and
  prints `[server] engine version <v>`. Only **tracked** files count: a new engine file changes the
  version once it is `git add`ed (both the server and Vite read the same index, so they agree).
- **`src/net/protocol.ts`**: everything in §2, plus what C3–C5 need. Names to know:
  `LIMITS` (frame/body/buffer sizes, name/chat limits, `actionsPerInput` 4, `staleTurns` 3,
  `hashEvery` 10, deadline/maxPlayers bounds and defaults, `maxRooms`, `invalidMax` 50,
  `rateDropsMax` 200, and `rates` per message type: the token buckets of §2), `PLAYER_COLOURS` (12),
  `cleanText` (strips C0/C1 controls and bidi overrides, trims), `codePoints`, `cleanChat(text)`
  (string, or null → the room answers `chat_long`; the schema lets up to `chatRawMax` 2000 through so
  the room can answer instead of counting it invalid). Schemas: `Code`, `Token`, `Name` (cleaned,
  1–24 code points), `Colour`, `Intent`, `Presence`, `PlayerIdSchema` (`p\d{1,3}`), `SeatId`
  (`s\d{1,4}`: C3 numbers seats `s1`, `s2`…), `DemoId`, `PlayerActionSchema`, `TurnInputSchema`,
  `LogEntrySchema` (+ types `LogEntry`, `LogEntryKind`, `LogEntryBody` = an entry without `n`/`run`,
  distributive), `Phase`, `RoomOptions`, `RoomInfo`, `SeatPresence`, `RosterEntry`, `ChatLine`,
  `Snapshot`, `ClientMsg`, `ServerMsg` (types `Hello`, `InputMsg`, `Welcome`, `Refused`, `Closed`),
  `ErrorCode`, `RefusedCode`, `ClosedReason`, `CLOSE` (4000 hello timeout, 4007 replaced, 4010
  closed, 1008, 1009) and `REFUSED_CLOSE` (4001–4006 by code), and the HTTP bodies
  `CreateRoomRequest` (exactly one of `demo` / `world`), `CreateRoomResponse`, `RoomList`,
  `WorldUploadRequest`. `parseClientMsg(raw)` / `parseServerMsg(raw)` take a frame's text or a parsed
  value (client frames over 16 K characters and anything nested deeper than `MAX_JSON_DEPTH` are
  null); `peekHello(raw)` → `{ engine }` or null. Extra keys are stripped, not refused.
- **Type check**: `SameType<A, B>` is the strict identity check (an optional field on one side only
  fails), applied in `protocol.ts` itself to `PlayerActionSchema` ↔ `PlayerAction` and
  `TurnInputSchema` ↔ `TurnInput`, so `tsc` fails on a new engine action; the test repeats it and
  shows with `@ts-expect-error` that it is strict.
- **Wire details** beyond the §2 table: `welcome.you.token` is always sent (the server knows the raw
  token from the `hello` on a reconnect); `welcome.world` / `run.world` are `unknown` (the client runs
  `parseWorld` and checks `worldId`); `refused.reason` is a `ClosedReason`; `refusal.reasons[]` has
  `{ action, reason, detail? }`; `entries.es` is non-empty; a `gm` entry's actions are `GmAction[]`
  (≤ 6, as `GmResponse`).
- **`src/net/log.ts`**: `applyEntry(world, state, e)` → `{ state, events }` with `env.world` passed
  (no registry needed); a `join` whose engine pid differs from the entry's throws; engine throws
  (leaveMap refusals) propagate, so the room must check before appending. Also `applyEntries` and
  `changedArea(before, after)` (area index differs). No-op entries return the same state object
  (setAway no-op, fully refused turn without busy/advance), which C3 uses to skip appending.
- **`src/net/messages.ts`**: `noticeFor(refused | closed)` → `{ key, reload }`; `outdated` →
  `net.outdated` with reload (also without the flag); `closed server_updated` and `refused room_closed`
  with `reason: 'server_updated'` → `net.serverUpdated`; the other codes and reasons have their own
  keys (`net.noRoom`, `net.roomFull`, `net.roomClosed`, `net.badToken`, `net.serverFull`,
  `net.closedIdle`, `net.closedEmpty`, `net.closedError`), listed in `NET_NOTICE_KEYS`; `net.reload`
  is the button label. en and nb strings are in the catalogs.
- **`src/net/version.ts`**: `ENGINE_VERSION` (`'dev'` without the define; never read by the server).
- **Tests**: `tests/net/protocol.test.ts`, `log.test.ts` (an explorer party of 3 on fixture-western
  with gm, away, back, leave, join and return entries: per-entry hash and events equal the direct
  calls, also after JSON + `LogEntrySchema` and from a mid-run snapshot; a recorded 2-player loop
  matches `runParty`'s `onTurn` states; parseWorld idempotent and `worldIdOf` stable on all 21
  worlds), `messages.test.ts`, `version.test.ts` (vitest define = `engineVersionFor`, the walk
  fallback and CRLF give the same hash, sim/messages edits do not change it, the override, and
  `/api/health.engine`).

### C3 as built

- **`n` is a count everywhere** (deviation, clarified in `protocol.ts` comments): the number of
  entries applied in the run, i.e. the next entry's `n`. A snapshot `{ n, state }`, `hello.lastN`
  (what the client has applied), `hash.n` (hashState after n entries, sent when `n % 10 === 0`),
  `applied.n` and `clock.n` all use it; a run starts with a snapshot at `n = 0`. Load skips log
  entries with `e.n < snapshot.n`. `welcome.entries` = the ring from `lastN` on (empty when the
  client is current); `lastN > n`, a `lastN` older than the ring (512) or another `run` → snapshot.
- **`server/rooms/timing.ts`**: `RoomTiming` (§Constants plus `idleSweepMs` 60 000 and
  `clockThrottleMs` 200), `roomTiming(partial)` (ignores unknown and non-positive values; C4 feeds it
  `ANYWORLD_TEST_TIMING`), `Scheduler` { `now`, `setTimer(at, fn)`, `cancel` }, `RealScheduler`
  (unref'ed timeouts), `ManualScheduler` (`advanceTo`, `advanceBy`, `flush`, `pending`, `nextAt`).
- **`clock.ts`**: `nextResolve(view, now)` → `{ resolve, wakeAt }` exactly as §4 (the view carries
  `travelMs` and `countdownTurnMs` too); the deadline starts at `max(firstAt, areaHoldUntil)`.
- **`room.ts`** (`Room`, `Conn { send, close }`, `RoomDeps { timing, scheduler, store | null, demos,
  log?, onClose?, releaseWorld?, seed?, token? }`). API for C4: `Room.create` / `Room.load` (the
  manager calls them), `addSeat(name?, colour?)` → `{ seat, token }` (the creator's host seat),
  `hello(conn, hello)` → `Refused | null` (null: welcome sent and subscribed), `message(conn, msg)`
  for every other parsed message, `disconnect(conn)` (ignored for a replaced socket),
  `uploadWorld(token, world)` → `'ok' | 'bad_token' | 'not_host' | 'bad_phase'` (lobby: replaces the
  world and writes the world file; ended: staged for the next `start`, not persisted), `info()`,
  `close(reason)`, `shutdown()` (snapshot + `bye`, closes with 1012), `lastActivityAt`. Read-only
  helpers for tests: `state`, `n`, `run`, `phase`, `host`, `chat`, `seatList()`, `recentEntries()`,
  `hashAt(n)`, `clockView()`. `EXIT_COUNTDOWN_TURNS` 10, `SNAPSHOT_EVERY` 100, `RING_SIZE` 512,
  `HASH_RING` 64.
- Room rules as built (beyond §3–§6): a `leave` message closes the socket with 1000; a removed seat's
  socket gets 4010. A hello's name and colour apply while the seat has no character (lobby, ended,
  the creator's first hello). When the first seat connects to a sleeping room, the other seats'
  2-minute timers start then and `away` entries are appended for their characters (after a restart
  the engine does not know they are away); `lastResolveAt` is reset too. A due leave blocked by the
  guards (`canLeave`: run on, ≥ 2 members, someone else standing) is retried after every evaluation,
  so it happens as soon as the condition clears (not another 2 minutes). The host is re-chosen
  whenever the host seat is not connected and another is (also on a hello to a room whose host is
  off). Pending inputs of players no longer in the party or down are dropped (else rule 3b would run
  the world at the travel cadence forever). `refusal` goes only for a fully refused (no-op) entry;
  refusals inside an appended turn are visible to clients by replaying. A GM answer that does not
  pass `LogEntrySchema` is dropped with a log line. The GM is asked after every `turn` entry (busy
  re-appends included, the same on replay), with `t` from `gmTranslate(world.meta.language)` (en/nb
  catalogs + `formatMessage`). Engine exceptions in any handler or timer close only that room
  (`closed { reason: 'error' }`). Not done: the "illegal outcomes > 20/min" log line (§9).
- **`store.ts`**: `RoomStore(dir = <data>/rooms)`: `writeWorld`, `writeRoom(file, truncate)`
  (snapshot = rewrite + truncate), `append`, `codes`, `load` (torn line ends the log), `remove`,
  `moveBroken`, `cleanTmp`, `tombstones(now)` / `addTombstones(add, now)` (7 days); `writeAtomic`;
  `linesToReplay` (entries of the file's run in sequence from `snapshot.n`, seat records last-wins,
  chat by id). Seat changes (new, renamed, `left`, pid, `removed: true`) are `{ seat }` log lines;
  `RoomFile` also has `host` and `nextSeat` (seat ids are never reused). The room file is rewritten
  without truncating on options changes and seat creation (keeping the stored snapshot and hooks).
- **`worlds.ts`**: `DemoWorlds(dir = content/worlds)`: `ids()`, `get(id)` (strict `parseWorld`,
  cached, null when missing or invalid), `loadedWorldIds()`.
- **`manager.ts`**: `RoomManager({ dir, engineVersion, timing?, scheduler?, demos?, maxRooms?, log?,
  seed?, token?, code? })`: `load()` → `{ loaded, closed, broken, tmpRemoved }`, `start()` (idle
  sweep every `idleSweepMs`), `create({ demo? | world?, options?, name? })` → `{ ok, code, token, room
  }` or `{ ok: false, error: 'server_full' | 'no_demo' }` (the world must already be validated: C4
  does parseWorld, the createGame timing and the 409), `list()` (newest first), `get(code)`,
  `tombstone(code)`, `hello(conn, hello)` → the room or null (checks engine → `outdated` with reload,
  tombstone → `room_closed` with its reason, unknown → `no_room`, then the room; refusals are sent
  and the conn closed with `REFUSED_CLOSE`), `shutdown()`, `closeAll(reason)`. A closed room's
  files are removed, a tombstone added and its world unregistered unless another room or a loaded
  demo uses it. Room codes avoid codes with a tombstone.
- **Tests**: `rooms-clock` (11), `rooms-room` (20: seats, removal, host, replace race, phases and
  play again, turns, deadline, idle, travel cadence, stale, no-op and refusal, typing, chat, late
  join, reconnect with entries, hashes and desync, area change with countdown and hold, the 2-minute
  path with both guards and the return, empty close, manager limits, idle close, shutdown),
  `rooms-store` (5: atomic write, tmp cleanup, replay filtering, torn line, tombstones, restart
  replay to the same hash and reconnect with entries, crash between rewrite and truncate, broken
  room, version closing with `room_closed / server_updated` and `outdated`).

### C4 as built

- **`server/rooms/ws.ts`**: `attachRoomSockets(server, { manager, allowedOrigins, clientIp, limits?,
  log? })` → `{ size, close(graceMs) }`, called by `createApp` when `AppOptions.rooms` is given. Only
  `/api/ws` upgrades (other paths 400, 503 while closing); `originAllowed(origin, host, list)`: listed
  origins only, or (only when the list is empty) `http(s)://<Host>`; a missing Origin is 403. The rule
  does not read `NODE_ENV`: with `ALLOWED_ORIGINS` set (production) the own host is refused too.
  `socket.on('error')` is attached first; per IP (the app's `clientIp`, so `TRUST_PROXY` applies)
  upgrades/min (429 with retry-after) and open sockets (429), sockets in all (503), counted before
  `handleUpgrade`. `WebSocketServer({ noServer, perMessageDeflate: false, maxPayload: 16 KB })`.
  `wsConn(ws, bufferBytes)` is the `Conn` (exported, unit-tested with a fake): JSON frames, and a send
  that leaves more than 4 MB buffered closes with 1009 and terminates. Before a hello, every frame takes
  from the buckets; a non-hello is `error invalid` (counted); `peekHello` engine mismatch → `refused
  outdated, reload` + 4001; then `parseClientMsg`; then `manager.hello`. After it: buckets
  (`ConnBuckets`, a drop sends `error rate`, 200 drops a minute → 1008), invalid → `error invalid`
  (50 → 1008), then `room.message`. Hello timeout = `timing.helloTimeoutMs` (4000). Pings every
  `limits.pingMs` (15 s), two missed pongs terminate. `close(graceMs)` stops accepting, waits for the
  sockets to close, then terminates the rest.
- **`server/rooms/limits.ts`**: `RoomLimits` (`upgradesPerMin` 20, `socketsPerIp` 16, `socketsTotal`
  200, `createsPer10Min` 6, `listPerMin` 60, `firstAreaMs` 2000, `socketBufferBytes` 4 MB, `pingMs`
  15 000), `roomLimits(partial)` (0 allowed), `TokenBucket`, `ConnBuckets`.
- **Routes in `app.ts`** (only with `AppOptions.rooms = { dataDir, timing?, scheduler?, limits?,
  maxRooms?, demos? }`; without it nothing changes, so the existing server tests run as before):
  `GET /api/rooms` → `RoomList` (`max` = the manager's limit), `GET /api/rooms/:code` → `RoomInfo` or
  404 `no_room` (both 60/min per IP), `POST /api/rooms` (JSON ≤ 1 MB, depth guard; `engine` read first
  → 409 `{ kind: 'outdated', reload: true }`; then the creation limiter, so invalid bodies and uploads
  count; `CreateRoomRequest`; 503 `server_full`; an upload goes through `parseWorld` strict and a trial
  `createGame` for `options.maxPlayers` players, caught and timed against `firstAreaMs` → 400
  `invalid_world`, and the trial's registry entry is released) → 201 `{ code, token }`; `POST
  /api/rooms/:code/world { token, world }` (same checks and limiter; 403 `bad_token` / `not_host`, 409
  `bad_phase`) → 200 `{ ok, worldId }`. `RoomManager.releaseWorld` is now public. `ANYWORLD_MAX_ROOMS`
  is read in `createApp`. Error kinds: `outdated`, `server_full`, `no_demo`, `no_room`,
  `invalid_world`, `bad_token`, `not_host`, `bad_phase`, plus the existing `bad_request` / `rate_limit`.
- **Seen in testing (C3 rule, unchanged):** a guest whose hello arrives before the creator's first
  hello becomes host (`ensureHost` picks a connected seat). MP3's lobby should connect the creator
  right after `POST /api/rooms`.
- **`server/data-dir.ts`**: `resolveDataDir(env, root)` (ANYWORLD_DATA_DIR, then the first entry of
  STATE_DIRECTORY, then `<repo>/.data`), `ensureDataDir(dir)` → `<dir>/rooms` (mkdir + probe file;
  throws). `createApp` calls it too (tests pass a temp dir).
- **`server/index.ts`**: `startServer` returns `rooms: RoomManager | null` and `close(graceMs = 1000)`:
  `manager.shutdown()` (snapshot + `bye` + 1012), then the sockets get `graceMs` to close and are
  terminated, then `server.close()`. Exported helpers `testTiming(env)` (ANYWORLD_TEST_TIMING JSON,
  ignored in production; bad JSON fails the start) and `dataDirOrExit(env, tag)` (prints `[server]
  cannot use data directory <dir>: <error>`, exit 1). `main()` prints `[server] rooms in <dir>` and,
  last, `[server] listening <port>`; SIGTERM/SIGINT run `close()` and exit 0. `dev.ts` does the same
  (data dir, test timing) and its Vite proxy has `ws: true`, as has `vite.config.ts`.
- **`src/net/client.ts`** (`RoomClient`, not in the engine hash): `new RoomClient({ url, socket:
  SocketFactory, engine, room, name, colour, token?, reconnect?, backoffMs?, setTimer?, clearTimer?
  })`; `connect()`, `joined()` (resolves on the first welcome, rejects with the notice key or a world
  fault), `on(fn)` with `RoomEvent`s (`welcome`, `entries` with engine events, `state` (welcome /
  snapshot / run), `notice` (noticeFor), `fault` (`world_invalid`, `world_mismatch`, `gap`, `apply`,
  `invalid_message`), `status`, `message` for everything else). Public fields: `status`, `token`,
  `seat`, `pid`, `host`, `phase`, `run`, `n`, `world`, `worldId`, `state`, `options`, `roster`, `chat`,
  `desyncs`, `reconnects`, `invalid`. Senders: `send(msg)`, `input(actions, intent, busy?)` (area and
  turn from the replica), `say`, `typing`, `presence`, `start(demo?)`, `leave()`; `stop()`, and
  `drop()` (closes the socket as a network failure would, then reconnects: for C5's FaultyChannel).
  It registers the parsed world in the engine registry (the bots' and the UI's view helpers need it).
  Reconnect backoff 0.5 → 5 s; hello carries `token`, `run` and `lastN` (no `lastN` after a gap or a
  refused entry, so the server sends a snapshot). No reconnect after `refused`, `closed`, 4007, 1008 or
  `stop()`. `pid` follows the roster (a new run renumbers seats). A `ws` factory in Node:
  `(url) => new WebSocket(url, { headers: { origin } }) as unknown as RoomSocket`.
- **Tests**: `tests/server/rooms-limits.test.ts` (24: data dir, rooms off, Origin with and without the
  list, bad paths, per-IP and total sockets, TRUST_PROXY on upgrades, frame size, pings, close(),
  hello order and timeout, invalid and rate drops, buckets, backpressure, the HTTP routes and limits),
  `tests/server/rooms-smoke.test.ts` (two RoomClients play, chat, drop and reconnect, hashes equal the
  server's; the child process: `listening`, the knobs, SIGTERM snapshot + bye + exit 0, refusal to
  start on a bad data dir), `tests/net/client.test.ts` (6, fake socket). Shared helpers in
  `tests/server/rooms-helpers.ts` (`boot`, `openRaw`, `upgradeStatus`, `wsClient`, `until`), usable by
  C5. Not done: the design §9 log line for > 20 `illegal` outcomes per minute per seat (C5 may add it).

### C5 as built

- **`tools/rooms/scripted-client.ts`**: `ScriptedClient(opts)` wraps a `RoomClient` (`client`) with
  `wsFactory(origin)`; `connect()`, `play(entries)`, `playUntil(done)` (the bot keeps playing until
  `pause()`), `drop({ stay? })` (`stay`: the socket closes and stays off until `reconnect()`; else
  `RoomClient.drop()` and it reconnects), `close()`. It records `entries` (contiguous from n = 0 unless a
  snapshot came: `snapshots`), `runStart` (the replica at the `run` message, for replay checks),
  `refusals`, `errors`, `notices`, `faults`, `sent`, `said`. The bot: one turn action per ready turn
  (`readyPlayers` on the replica, intent `decide`), free actions one at a time, each after its entry
  arrived (at most `MAX_FREE_PER_TURN`, then `wait`), bot memory fed from the turn outcomes; a watchdog
  re-decides after `retryMs` without a new entry (a lost input, or a stale / refused one). The chat
  script sends `typing` then a line `typingMs` later, about every `chatEvery` entries, at most one a
  1.1 s. `FaultyChannel({ delayMs, stallEvery, stallMs, closeEvery, dropInputs, seed })` wraps the
  socket factory: per-socket ordered delay queues both ways, stalls on the incoming side, a random
  close calls `RoomClient.drop()` after the frame it follows, and only `input` frames are lost;
  `stats` counts frames, stalls, closes and lost inputs. Seeded with `rng(seed)` (mulberry32).
- **`tools/room-bots.ts --url … [--room CODE] [--bots 4] [--bot list] [--entries 150] [--chat-every 25]
  [--origin] [--engine] [--timeout 300]`**: creates a demo room (the first bot is host and starts) or
  joins one as guests, plays, waits for every client at one n and prints `[room-bots] ok room <code>
  n=<n> … hash=<h>` (exit 0) or exits 1 when they disagree, on a refusal or the timeout. The engine
  version is `computeEngineVersion()` of the checkout unless `--engine`.
- **Additions outside the step's files** (small, needed by the checks):
  - `Applied.outcomes` in `src/net/log.ts` (a turn entry's `TurnOutcome[]`, empty for other kinds) and
    `outcomes` on RoomClient's `entries` event, so a client knows its refused actions (bots, and MP3's
    UI). This changed the engine version hash, as any `src/net/log.ts` edit does.
  - `RoomTiming.deadlineMs` (default 0 = off; tests only, through `startServer({ rooms: { timing } })`
    or `ANYWORLD_TEST_TIMING`): replaces every room's deadline in the clock view, so socket tests run
    with 300 ms while the protocol bounds stay 1000–5000 ms. Ignored in production like the other knob.
  - The design §9 log line: a room logs `pN: more than 20 illegal actions in a minute` once per
    player per minute (`ILLEGAL_LOG_PER_MIN`), counted over appended turn entries.
  - `tests/server/rooms-helpers.ts`: `spawnTs` (node with `--import tsx` in one process: the `tsx`
    binary runs the program in a second process and cannot pass SIGKILL on, which left servers
    behind), `spawnServer(env, onSpawn)` (also removes `ALLOWED_ORIGINS`), `freePort`, `exited`,
    `killChild`. `rooms-smoke.test.ts` uses them now.
- **Tests**: `tests/server/rooms-exit.test.ts` (7, ~40 s; the file's tests run in order, `timeout`
  240 s): play (4 bots, ≥ 150 entries and on to the second area, chat every 25, hashes and chat equal
  the server's, no snapshots, busy entries from typing, GM `intro` and `area_enter`), restart (SIGKILL
  a child on a fixed port, the files replay to the clients' entries and to an uninterrupted replay from
  `runStart`, the restarted child on the same port and dir: reconnect with tokens, same pids, caught up
  by entries with only `away` / `back` after the replayed n, 50 more entries, SIGTERM snapshot equals
  the clients' hash), version (`v-one` → `v-two`: files gone, `/api/rooms` empty, open pages refused
  `net.outdated` with reload, a reloaded page with the old token gets `room_closed / server_updated` →
  `net.serverUpdated`), outdated (raw hello and an otherwise invalid hello → `outdated, reload` and
  4001, RoomClient rejects with `net.outdated`, POST from a listed origin → 409), reconnect (roster
  `off`, `away` entry, ≥ 30 entries without it, no hostile `targetId` on it and no attack from the
  second turn on, same pid and a `back` entry on return, no snapshot), faults (4 bots with delay
  20–250 ms, stalls, random closes, 5 % lost inputs, ≥ 100 entries: every client on the server hash;
  lost inputs, stalls and closes all happened; a typical run had 0 snapshots), bots (`room-bots.ts` as
  a child against a child server with the computed version). `tests/server/scripted-client.test.ts`
  (FaultyChannel order, stalls, lost inputs only, dropper; seeded rng); `rooms-room` +1 (the deadline
  override and the illegal log line).

## Constants

| Name | Value | Where |
|---|---|---|
| `MAX_ROOMS` | 10 (env `ANYWORLD_MAX_ROOMS`) | manager |
| `DEFAULT_MAX_PLAYERS` / max | 8 / 12 (`MAX_PARTY_SIZE`) | room options |
| `deadlineMs` | 2000 default (1000–5000) | room options |
| `EXIT_COUNTDOWN_TURNS` | 10 | run creation |
| `STALE_TURNS` | 3 | room |
| `CHAT_HISTORY` / `CHAT_MAX` / chat rate | 100 / 200 / 1 per s | room |
| `SNAPSHOT_EVERY` / ring buffer / hash ring | 100 / 512 / 64 | room, store |
| `HASH_EVERY` | 10 | client |
| `maxPayload` / room body / socket buffer | 16 KB / 1 MB / 4 MB | ws, app |

`RoomTiming` defaults (injectable, never set over the protocol): `travelMs` 100, `countdownTurnMs` 1000,
`areaHoldMaxMs` 3000, `idleActiveMs` 10 000, `typingExpiryMs` 8000, `awayMs` 120 000, `idleCloseMs` 2 h,
`helloTimeoutMs` 5000.

## Review notes

Three independent reviews (rules, engine, risk) of the first version; one line per point.

**Rules review**
1. Accepted: the server and Node tools never read the `'dev'` fallback; they use `computeEngineVersion` / `AppOptions.engineVersion`; a bots-against-child-server case was added.
2. Accepted: `peekHello` checks the version before full validation, and `src/net` (lockstep parts) is in the hash.
3. Accepted: the data dir comes from `ANYWORLD_DATA_DIR`, then `STATE_DIRECTORY`, then `.data/`, never from `NODE_ENV`.
4. Accepted: the 15-minute empty close is dropped; rooms close when every seat has left or is gone, or after 2 h idle.
5. Accepted: no timers at all while no seat is connected (countdown included); the rounds-vs-turns approximation is written down.
6. Accepted: `FaultyChannel` models delay, jitter, stalls and socket closes, and drops only outgoing inputs; `sync` and the gap wait are removed.
7. Accepted: `noticeFor` maps refusals and closes to i18n keys, unit-tested and asserted in the exit checks; the toast is MP3.
8. Accepted: `TRUST_PROXY=1` is required in production, and the per-IP limits are injectable.
9. Accepted: test timing goes through `RoomTiming` injection; the zod bounds are unchanged.
10. Accepted: lobby seats away for 2 min are removed, off seats at start get a character and the 2-minute rule, and names and colours are made unique.
11. Accepted: `addPlayer` / `returnToMap` take a `near` pid and rooms pass the host's.
12. Accepted: the app-level ping and the `'away'` presence are dropped, and the world is written once to its own file.

**Engine review**
1. Accepted: when no pending input is from a ready player (including the party-of-one-after-leave case), the turn resolves with `advance: true`.
2. Accepted: append before broadcast; `lastN` greater than `n` or another run gets a snapshot.
3. Accepted: no `leaveMap` while every other party member is down; the timer re-arms.
4. Accepted: a returning player gets an empty pack and the hp it left with.
5. Accepted: `welcome` / `run` carry `worldId`, the client checks it, a test covers `parseWorld` idempotence on 21 worlds, and `unregisterWorld` was added.
6. Accepted: the hash covers git-tracked `.ts` files in `src/engine`, `src/schema` and `src/net`, minus sim, balance and client-only net files; an env override is added; the toast offers a reload button only, and HOSTING says to deploy both together.
7. Accepted: a duplicate of rules review 5.
8. Accepted: carried-over inputs get a fresh deadline start.
9. Accepted: `ws` clients are terminated in `close()`, an error handler is attached before the upgrade, other paths get 400, deflate is off, and a backpressure limit was added; the https-behind-Caddy point is handled by the stricter Origin rule (risk review 11).
10. Accepted differently: tokens travel in the JSON body, so no new CORS header is needed; the 409 from a listed origin is tested.
11. Accepted: no-op entries are not appended (a `refusal` goes to the actor instead), and staleness is measured in area and engine turns.
12. Accepted: party-scaling asserts are updated in C1, the fixed `partySize` per area and the lead-fog limit of the canned GM are noted, and the version is checked before the token.

**Risk review**
1. Accepted: an engine `away` flag (`setAway`, `away` / `back` entries) has no turn cap, and busy is re-appended for a typing seat whose own action cleared it.
2. Accepted: pending inputs are cleared on an area change, and inputs carry their area.
3. Accepted: a single injected `RoomTiming`; `EXIT_COUNTDOWN_TURNS` is a constant; the env knobs are allowed only outside production.
4. Accepted: `nextResolve` returns `wakeAt`, there is an injected `Scheduler` with a manual clock in tests, and an empty active set counts as "all acted".
5. Accepted: `seat.conn === thisConn` guards, an atomic welcome-plus-subscribe, and the away timer cancelled before rebinding.
6. Accepted: a duplicate of engine review 11, plus `error stale`.
7. Accepted: a duplicate of engine review 6, and HOSTING notes restarting Vite and the server after engine edits in dev.
8. Accepted: separate world file, tmp cleanup, atomic tombstones, and a note on why `appendFileSync` is not torn by kill -9.
9. Accepted: `decide` intent, smaller entry counts, one sequential exit-check file with its own timeout, the 2-minute path on the manual clock, and kills by PID with a `listening` line.
10. Accepted: a `PlayerAction` type check, the token in the body, and `clientIpFrom` on upgrades.
11. Accepted: production uses only `ALLOWED_ORIGINS`, and invalid uploads count toward the creation limit. Partly accepted: `createGame` is caught and the first area is timed (2 s cap), but later areas cannot be capped without the worker thread the owner left as a possible improvement.
12. Accepted: the baseline goes in C1, `Difficulty` comes from `src/schema/gm.ts`, `engineVersion` is a manager constructor argument in C3, and the scripted client lives under `tools/rooms/`.
