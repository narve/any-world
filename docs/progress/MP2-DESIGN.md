# MP2 — Room server (design)

Date: 2026-10-28. Branch `multi`. Scope: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3 row MP2 with
§1, §2, §2.1 and the owner decisions in §6; builds on [MP1.md](MP1.md) ("Known gaps for MP2"). Server,
protocol and engine bits only: no lobby, chat or multiplayer view in the client (MP3), no AI game
master in rooms (MP4). The single-player client plays exactly as today (it does not use rooms); the
golden replay (`tests/engine/golden-replay.test.ts`) and the new-player gate stay unchanged.

## 1. Module layout

| Path | Content | Runs in |
|---|---|---|
| `src/net/protocol.ts` | zod schemas and types for every message, limits (`LIMITS`), `PROTOCOL = 1`, `parseClientMsg` / `parseServerMsg` | client build, server, tests |
| `src/net/log.ts` | `LogEntry` and `applyEntry(world, state, entry)`: the one function that moves a room's state (server, restart replay, clients, tests) | all |
| `src/net/client.ts` | `RoomClient`: socket wrapper with ordering, gap sync, hash reports, reconnect with token; takes a socket factory (browser `WebSocket`, or `ws` in Node) | all (MP3 uses it in the browser) |
| `src/net/version.ts` | `ENGINE_VERSION` (build-time constant, §8) | all |
| `src/gm/offline.ts` | `OfflineGmDirector`, `gmHooksFor`, `HookTracker` moved from `src/client/gm-director.ts` (no DOM; labels through an injected `t`) | all |
| `server/engine-version.ts` | `computeEngineVersion(root)`: hash of `src/engine` + `src/schema` | vite config, server start-up |
| `server/data-dir.ts` | `resolveDataDir(env)`, `ensureDataDir(dir)` | server |
| `server/rooms/room.ts` | `Room`: seats, roster, phases, engine state, turn clock, chat, GM, hash checks | server |
| `server/rooms/clock.ts` | pure `nextResolve(view, now)` (§4) | server |
| `server/rooms/manager.ts` | `RoomManager`: create, list, find, limits, idle sweep, load at start, shutdown | server |
| `server/rooms/store.ts` | room file + append log, atomic writes, load and replay (§7) | server |
| `server/rooms/ws.ts` | upgrade handling on the `node:http` server, Origin check, per-IP limits, `Conn` | server |
| `server/rooms/worlds.ts` | demo worlds from `content/worlds` (lazy, `parseWorld`, cached by file id) | server |
| `server/rooms/limits.ts` | `TokenBucket` per connection (reuses `RateLimiter` for per-IP keys) | server |
| `tests/net/scripted-client.ts` | scripted Node client: `RoomClient` + a sim bot + chat script + `FaultyChannel` (§11) | tests, `tools/room-bots.ts` |

The protocol is shared the way `src/llm` already is: the server imports `src/net` directly through tsx,
Vite bundles it into the client, and both validate with the same zod schemas. `src/net` imports only
`src/engine`, `src/schema`, `src/gm` and zod (no `node:` modules, no DOM). `src/client/gm-director.ts`
keeps `GmRunner` and re-exports the moved names, so the client code and its tests do not change.

Dependencies: `ws` 8.22.0 and `@types/ws` 8.18.2 (dev), pinned exactly like the others. Nothing else.

## 2. Protocol

Text frames of JSON, one message each, discriminated by `t`. Incoming frames over 16 KB are refused by
`ws` (`maxPayload: 16384`); a world (up to ~140 KB today) is uploaded over HTTP (§3), never over the
socket. Every incoming message goes through `parseClientMsg`; invalid or unknown ones are dropped and
counted (`conn.invalid`); 50 invalid messages close the socket (1008). Outgoing messages are validated
in tests only (`parseServerMsg` in the client and the scripted client).

```ts
const Code = z.string().regex(/^[2-9A-HJ-NP-Z]{4}$/);          // room code, no 0/O/1/I/L
const Token = z.string().regex(/^[A-Za-z0-9_-]{22}$/);         // 128-bit, base64url
const Name = z.string().trim().min(1).max(24);                 // control characters stripped first
const Colour = z.enum(PLAYER_COLOURS);                         // 12 fixed colours ('#e6194b'…)
const Intent = z.enum(['decide', 'travel', 'wait']);
const Presence = z.enum(['playing', 'menu', 'away']);          // client view state; 'away' = tab hidden
const PlayerActionSchema = z.discriminatedUnion('type', [ … ]); // mirrors engine PlayerAction, ints bounded
```

Client → server:

| `t` | Fields | Limits |
|---|---|---|
| `hello` | `v: 1`, `engine` (≤ 64), `room: Code`, `token?`, `name`, `colour`, `lastN?`, `run?` | first message, within 5 s, else close 4000 |
| `input` | `n` (last step applied), `actions: PlayerAction[]` (≤ 4), `busy?`, `intent` | 20/s, burst 40 |
| `presence` | `state: Presence` | 4/s |
| `typing` | `on: boolean` | 4/s |
| `chat` | `text` (1–200 code points after trim) | 1/s (§5) |
| `hash` | `n`, `h` (16 hex) | 2/s |
| `sync` | `from` (first missing step) | 2/s |
| `applied` | `n` (an area-change step is applied locally, §4) | 2/s |
| `start` | `demo?` (file id) | host only; lobby or ended phase |
| `options` | `deadlineMs?` (1000–5000), `maxPlayers?` (2–12, ≥ seats) | host only |
| `leave` | — | — |
| `ping` | `at` | 2/s |

Overall 40 messages/s per connection; a message over a bucket is dropped with a non-fatal `error`
(`rate`), and 200 drops in a minute close the socket (1008).

Server → client:

| `t` | Fields |
|---|---|
| `welcome` | `room: RoomInfo`, `you: { seat, pid \| null, token, host }`, `roster`, `phase`, `run`, `options`, `world?` (omitted when `hello.run` matches and the client has it), `snapshot?: { n, state }` (`serialize`), `entries?: LogEntry[]` (when `lastN` is in the ring buffer), `chat: ChatLine[]` |
| `entries` | `run`, `es: LogEntry[]` (usually one; batched after a sync) |
| `snapshot` | `run`, `n`, `state` (desync or a gap older than the ring buffer) |
| `run` | `run`, `world?`, `snapshot` (a new run: "play again") |
| `roster` | `seats: RosterEntry[]` (on change) |
| `clock` | `n`, `acted: PlayerId[]`, `waiting: PlayerId[]`, `deadlineInMs?` (throttled to 5/s; MP3's "2 of 3 acted") |
| `chat` | `line: ChatLine` |
| `typing` | `seat`, `on` |
| `error` | `code: 'rate' \| 'invalid' \| 'not_host' \| 'chat_rate' \| 'chat_long' \| 'bad_phase'`, `message` (non-fatal) |
| `refused` | `code: 'outdated' \| 'no_room' \| 'room_full' \| 'room_closed' \| 'bad_token' \| 'server_full'`, `message`, `reload?: true`, `reason?` (then close 4001–4006) |
| `closed` | `reason: 'server_updated' \| 'idle' \| 'empty'`, `message` (then close 4010) |
| `bye` | `reason: 'restart'` (graceful shutdown; clients reconnect with backoff 0.5–5 s) |
| `pong` | `at` |

```ts
interface RosterEntry { seat: string; pid: PlayerId | null; name: string; colour: string; host: boolean;
  connected: boolean; presence: 'active' | 'busy' | 'menu' | 'idle' | 'away' | 'off' | 'gone'; since: number }
interface ChatLine { id: number; seat: string; name: string; colour: string; text: string; at: number }
interface RoomInfo { code: string; world: { id: string; title: string; genre: string; language: string };
  players: number; maxPlayers: number; phase: 'lobby' | 'playing' | 'ended'; joinable: boolean }
```

**Join and reconnect.** `hello` without a token takes a new seat (`room_full` when seats = maxPlayers;
a seat whose player left the map still counts, §3). With a token the server finds the seat by
`sha256(token)`; an unknown token is `bad_token` (the client then joins as new). A second socket with
the same token replaces the first, which is closed with 4007 ("replaced": the player opened a new tab). The token is created at the first join, sent once in
`welcome`, kept by the browser (MP3: `localStorage` per room code) and stored hashed.

**Engine-version handshake.** `hello.engine !== ENGINE_VERSION` → `refused { code: 'outdated', reload:
true, message: 'A new version is out: reload the page.' }`; the same check answers `POST /api/rooms` with
409 `outdated`. A room whose stored version differs from the server's is closed at start-up (§7) and a
token for it gets `refused { code: 'room_closed', reason: 'server_updated' }`. `RoomClient` surfaces
both as `onRefused(code, { reload })`; the en/nb strings (`net.outdated`, `net.serverUpdated`,
`net.roomClosed`) land in MP2, the toast itself in MP3.

## 3. Room lifecycle

HTTP routes in `server/app.ts` (CORS as for `/api` today):

- `GET /api/rooms` → `{ rooms: RoomInfo[], max: 10 }` (open rooms, newest first; 60/min per IP).
- `GET /api/rooms/:code` → `RoomInfo` or 404 (the `?room=K7QX` link lands here first).
- `POST /api/rooms` `{ engine, demo? | world?, options?: { maxPlayers, deadlineMs, difficulty } }` →
  201 `{ code, token }`. Body ≤ 1 MB; an uploaded world goes through `parseWorld(json, { strictKeys:
  true })` and is refused (400 with the first 5 errors) when invalid; `demo` must name a file in
  `content/worlds`. 6 rooms per IP per 10 min; 503 `server_full` at 10 rooms. The token is the
  creator's seat (the host); they then connect with `hello { token }`.
- `POST /api/rooms/:code/world` (header `x-anyworld-seat: <token>`, host only, ended or lobby phase) →
  a new uploaded world for "play again".
- `/api/ws`: the WebSocket upgrade (§9). The dev proxies (`vite.config.ts`, `server/dev.ts`) get
  `ws: true`.

**Phases.** `lobby` (created; seats join, `start` by the host creates the run with every connected
seat's name, `createGame({ seed, players, difficulty, exitCountdownTurns })`, seed from
`crypto.randomInt`) → `playing` → `ended` (state status `won` / `lost`). In `ended` the host sends
`start { demo? }` (or uploads a world first): a new run (`run + 1`, new seed, new log, `n = 0`) with
every seat that is connected or away for less than 2 minutes; others lose their seat. Entries carry
their `run`, so a late message from the old run is dropped.

**Late join** (phase `playing`): a new seat gets a `join` entry; `addPlayer` places them next to the
lead; `welcome` brings the snapshot after it.

**Disconnect and the 2-minute rule** (`AWAY_MS = 120_000`):

1. The socket closes (or misses two `ws` pings, 15 s apart): the seat is `off`; the server appends a
   `{ k: 'turn', inputs: [{ playerId, busy: true }] }` entry (hostiles leave them alone for at most
   `BUSY_MAX_TURNS`); they never count as active (§4).
2. Reconnect within 2 minutes with the token: same seat and pid, `busy: false` entry (unless typing or a
   choice is open), `welcome` with the missing entries or a snapshot.
3. After 2 minutes away: a `leave` entry, engine `leaveMap` (§10a): the character leaves the map, its
   items drop where it stood; the seat is `gone` but kept (counts against maxPlayers) until the run ends.
   Reconnecting later appends a `return` entry (`returnToMap`).
4. A `leave` message counts as a disconnect at once (the same 2 minutes; leaving is not a punishment).
   Nobody leaves the map while no seat is connected (an empty room just sleeps), and the last player in
   the party never leaves it.

**Host hand-over**: when the host's socket closes, the connected seat with the oldest `connectedSince`
becomes host (`roster` broadcast); a returning ex-host does not take it back. No kicking.

**Closing**: idle 2 h (no input and no chat; `IDLE_MS`, swept every minute) → `closed { reason:
'idle' }`; empty (no seat connected) for 15 min, or every seat sent `leave` → `closed { reason: 'empty'
}`; an engine-version change at start-up → `server_updated` (§7). A closed room's files are removed and
its code kept in a tombstone list for 7 days so tokens get `room_closed` rather than `no_room`.

## 4. The turn clock

```ts
/** src/net/log.ts — the room's state only ever moves through these (n counts entries, from 0 per run) */
type LogEntry = { n: number; run: number } & (
  | { k: 'turn'; inputs: TurnInput[]; advance: boolean }        // engine stepTurn
  | { k: 'gm'; hook: GmHook; actions: GmAction[] }              // engine applyGmActions
  | { k: 'join'; seat: string; name: string; pid: PlayerId }     // addPlayer (pid checked, not chosen)
  | { k: 'leave'; pid: PlayerId }                                // leaveMap
  | { k: 'return'; pid: PlayerId });                             // returnToMap
export function applyEntry(world: WorldSpec, state: GameState, e: LogEntry): { state: GameState; events: GameEvent[] };
```

The server applies an entry, then broadcasts it; clients apply the same entries in order with the same
function (lockstep; a few hundred bytes per entry). The server is the authority.

**Inputs.** `input` splits into its free actions (talk, choose_option, choose_perk, toggle_sneak),
appended at once as their own `turn` entry with `advance: false` (they never move the world, so nobody
waits for them), and at most one turn action, kept as the seat's pending input for the next turn
(latest wins). `busy` alone is a `turn` entry too. An input whose `n` is more than 20 behind is dropped
(the client is resyncing). A pending input from a player who is not engine-ready (slower than the
others) stays pending until a turn where they are.

**Active players** (`activeIds`): engine `readyPlayers(state)` ∩ seats that are connected, `presence:
'playing'`, not typing, without an open `pendingChoice` (dialogue, trade, offer), and with an input or
presence change in the last 10 s (`IDLE_ACTIVE_MS`). Everyone else is inactive and never holds up a turn.

```ts
interface ClockView { active: PlayerId[]; pending: Map<PlayerId, { intent: Intent; at: number }>;
  firstAt: number | null; lastResolveAt: number; deadlineMs: number; countdown: boolean;
  areaHoldUntil: number | null }
/** server/rooms/clock.ts: when the next turn resolves, or null (nothing to do: the world waits) */
export function nextResolve(v: ClockView, now: number): { at: number; advance: boolean } | null;
```

Rules, in order:

1. **Exit countdown** (`state.area.exitCountdown` set): turns resolve every `COUNTDOWN_TURN_MS = 1000`
   (`at = lastResolveAt + 1000`, `advance: true`), whether or not anyone acted. Rooms create their runs
   with `exitCountdownTurns = round(EXIT_COUNTDOWN_MS / COUNTDOWN_TURN_MS) = 10`, so the countdown lasts
   about 10 s of clock time.
2. **Area hold**: after an entry that changed area (map generation, up to ~0.6 s on the server and on
   each client), `areaHoldUntil = min(all connected seats sent applied {n}, resolvedAt + 3000)`; no
   deadline starts before it, and pending inputs wait. The generation time counts against nobody.
3. **Everyone active has acted**: if any pending intent is `decide`, resolve now; if all are `travel` /
   `wait`, resolve at `lastResolveAt + TRAVEL_MS (100)` (the travel cadence). `advance: false`.
4. **Deadline**: some input is pending and someone active has not acted: resolve at `firstAt +
   deadlineMs` (room option, 1–5 s, default 2 s) with `advance: true` (ready players without input
   wait). `firstAt` is when the first pending input arrived, but not before `areaHoldUntil`.
5. **No input pending** (outside a countdown): null. While nobody acts the world does not move.

The room re-evaluates on every input, presence, typing, connect/disconnect and timer, keeps one Node
timer for the earliest `at`, and resolves with `applyEntry({ k: 'turn', inputs: pending, advance })`.
`lastResolveAt` is taken after the step, so a slow step (area entry) shortens nobody's next deadline.
`clock` messages tell clients who has acted and the deadline left.

**After each turn entry** the server checks for GM moments (§6), for run end (phase `ended`, snapshot),
and for an area change (snapshot, area hold).

**Desync guard.** Clients send `hash { n, h: hashState(state) }` after every entry with `n % 10 === 0`.
The server keeps its own hashes for the last 64 such `n` (computed when the entry is applied) and the last
512 entries in a ring buffer. A mismatch sends that client a `snapshot` and is logged (`[room K7QX]
desync seat s2 at n=340`). A client that sees a gap in `n` waits 1 s for the missing entries, then sends
`sync { from }`; the server answers with `entries` from the ring buffer, or a `snapshot` when it is older.

## 5. Chat

`chat { text }`: control characters stripped, trimmed, 1–200 code points (`chat_long` otherwise), at
most 1 message/s per seat (`chat_rate`). The server stamps `{ id, seat, name, colour, text, at }`,
appends it to the room's history (ring of `CHAT_HISTORY = 100`, persisted, §7; kept across runs so the
MP4 game master can read it) and broadcasts it to every connected seat. Chat never touches the engine
and never costs a turn.

`typing { on: true }` broadcasts `typing` and appends a `busy: true` turn entry (the seat becomes
inactive and busy for hostiles, capped at `BUSY_MAX_TURNS` by the engine); `on: false`, a sent chat line,
or 8 s without a refresh (clients repeat `on: true` every 3 s while typing) ends it with `busy: false`.
Speech bubbles, the side column and emotes are MP3; pings and emotes reuse `chat` in MP3.

## 6. Canned GM lines in rooms

`OfflineGmDirector`, `gmHooksFor`, `HookTracker`, `eventFlag` and friends move to `src/gm/offline.ts`
unchanged in behaviour. The one i18n use (offer labels) becomes an option: `new OfflineGmDirector({ t })`;
the client passes its `t`, the server a lookup in the world's language catalog (`catalog(world.meta.
language) ?? en` via `formatMessage`; `src/client/i18n` has no DOM dependency outside guards, but the
server imports only `en.ts` / `nb.ts` and `message-format.ts`).

Per room: a `HookTracker` (persisted with the snapshot) and one director. After every `turn` entry:
`hooks = gmHooksFor(world, before, after, events, tracker)`; each hook → `director.respondSync(...)`;
a non-empty response is appended as a `gm` entry (sanitized with `sanitizeResponse`), so clients and
restart replays apply it as data and never run the director themselves. The `intro` hook is asked at run
start. As in MP1, GM actions target the lead player (MP4 makes the GM party-aware and swaps the director
for the AI one behind the same interface). On replay the tracker is rebuilt by calling `gmHooksFor`
again over the replayed entries, without asking the director.

## 7. Persistence

`ANYWORLD_DATA_DIR` (`server/data-dir.ts`): default `/var/lib/anyworld` when `NODE_ENV=production`
(the unit's `StateDirectory`), else `.data/` in the repo (added to `.gitignore`). `ensureDataDir` makes
`<dir>/rooms` (recursive) and writes and removes a probe file; on failure `main()` prints
`[server] cannot use data directory <dir>: <error>` and exits 1 (systemd shows it). Rooms are on when
`startServer` gets `rooms` (from `main()` and `dev.ts`, or tests with a temp dir); existing server tests
that do not pass it run without rooms and create no files.

Files per room, both written only by the room:

```ts
/** rooms/<code>.json — rewritten atomically (write <code>.json.tmp, fsync, rename) */
interface RoomFile { format: 1; code: string; engineVersion: string; createdAt: number; updatedAt: number;
  options: RoomOptions; phase: Phase; run: number; world: WorldSpec; worldSource: { demo: string } | { upload: string };
  seed: number; seats: SeatRecord[]; snapshot: { n: number; state: string } | null;  // serialize()
  hooks: HookTracker; chat: ChatLine[] }
interface SeatRecord { seat: string; tokenHash: string; name: string; colour: string; pid: PlayerId | null;
  joinedAt: number; left?: boolean }
```

`rooms/<code>.log` — newline-delimited JSON, appended (`appendFileSync`) for every entry and every new
seat or chat line: `{ e: LogEntry }`, `{ seat: SeatRecord }`, `{ chat: ChatLine }`. A new snapshot
(every 100 entries, after an area change, at run start and end, at graceful shutdown) rewrites the JSON
and then truncates the log; on load, log entries with `n ≤ snapshot.n` or another `run`, duplicate
seats and chat ids, and a torn last line are skipped, so a crash between the two steps is harmless. A
`kill -9` loses nothing that was appended.

**Start-up**: `RoomManager.load()` reads every `rooms/*.json`: wrong `format` or unreadable → moved to
`rooms/broken/` with a log line (never fatal); `engineVersion` differs → the room is closed: files
removed, code added to `rooms/closed.json` (`{ [code]: { reason: 'server_updated', at } }`, pruned after
7 days); otherwise `parseWorld` (the stored world is treated as untrusted too), `deserialize` the
snapshot, replay the log with `applyEntry` (≤ 100 entries, a few ms), rebuild the GM tracker, all
seats `off` with their 2-minute timers started at load time. Clients reconnect with their tokens.

**Shutdown** (SIGTERM/SIGINT in `index.ts` and `dev.ts`): every room snapshots, every socket gets `bye`.

## 8. Engine version

`computeEngineVersion(root)`: every file under `src/engine` and `src/schema`, sorted by relative path
(`/` separators), each fed to sha256 as `path \0 content \0` with CRLF normalised to LF; the first 16
hex characters. No hand-kept number.

- **Client**: `vite.config.ts` calls it and defines `__ANYWORLD_ENGINE_VERSION__` (both modes, so the
  Pages build carries it); `vitest.config.ts` defines it the same way; `src/client/globals.d.ts`
  declares it; `src/net/version.ts` exports `ENGINE_VERSION` (`typeof … !== 'undefined'` guard, else
  `'dev'`).
- **Server**: runs from source through tsx, so "build time" is start-up: `main()` computes it once
  from the deployed checkout (`scripts/deploy.sh` pulls and restarts) and passes it as
  `AppOptions.engineVersion`. Tests inject a version to simulate a deploy or an outdated page.
  `/api/health` reports it (`engine`), which the deploy check prints.
- A test checks that the client define and the server computation agree.

## 9. Security

- **Origin**: every upgrade on `/api/ws` must carry an `Origin` that is in `ALLOWED_ORIGINS` or equals
  the request's own `http(s)://<Host>` (the page served by this server, or the Vite proxy in dev); else
  403 before the upgrade. A missing Origin is refused (tests send one).
- **Validation**: every message through zod (§2), with bounded strings, arrays and integers; actions use
  `PlayerActionSchema`, and the engine still refuses what is not possible ('illegal' outcomes are counted
  per seat and logged above 20 per minute). Uploaded worlds: content-type JSON, ≤ 1 MB, `JSON.parse`
  with the existing depth guard (`src/schema/json-depth.ts`), `parseWorld` with strict keys. Names and
  chat lose control characters; colours are a fixed list.
- **Sizes**: `maxPayload` 16 KB on the socket; HTTP bodies 1 MB for rooms (the 4 MB limit stays for
  `/api/llm`).
- **Rate limits**: per connection, token buckets per message type and overall (§2); per IP (with
  `TRUST_PROXY` handled by `clientIpFrom`): 20 upgrades/min, 16 open sockets, 6 room creations per 10 min,
  60 list calls/min; 200 sockets in all. `hello` within 5 s; `ws` pings every 15 s.
- **Room limits**: 10 rooms (`ANYWORLD_MAX_ROOMS`), 8 players by default, the host may set 2–12; idle
  close after 2 h. Room codes are not secret (rooms are public, owner decision); seat tokens are 128-bit
  random and stored as sha256 hashes.
- **Isolation**: a room's engine call that throws is caught; the room is closed with a log line and a
  `closed` message, the process and other rooms go on.

## 10. Engine changes

**a. Leaving and returning** (`src/engine/index.ts`, core in `party.ts`):

```ts
/** the player's character leaves the map: items drop where it stood (pack and equipment), its dialogue
 *  ends, hostiles drop it as a target, its allies follow the lead; it leaves `party` but stays in
 *  `players` with `left: { turn }`. Pure. Throws for the last party member. */
export function leaveMap(state: GameState, pid: PlayerId, env?: EngineEnv): StepResult;
/** back next to the lead (as addPlayer): full hp, level, xp, perks and knowledge kept, the world's
 *  starting kit (its old items lie where it left them, or in an earlier area), fresh fog */
export function returnToMap(state: GameState, pid: PlayerId, env?: EngineEnv): StepResult;
```

`PlayerState.left?` is optional and absent in single player, so saves and hashes of a party of one are
unchanged (`hashState` already walks players outside `party`). `moveOn` already falls back to the lead
when the countdown's `by` is gone; `checkEnd` runs after both.

**b. Bosses scale with the party.** Today a unique hostile's hp scales with `PARTY_SCALING.uniqueHp`
(0.5) instead of `hostileHp`. MP2 adds, for parties of 2+ only (`n > 1`, so single player and the golden
replay are unchanged):

- `PARTY_SCALING.uniqueHp` 0.5 → 0.8 (a boss faces the whole party's focus fire);
- new `PARTY_SCALING.uniqueDamage = 0.1`: damage a unique hostile deals ×`partyFactor(n, 0.1)`, in
  `combat.ts` next to the band's `hostileDamage` (n = `area.partySize`).

The numbers are a starting point, tuned in step C1 with `tools/sim.ts --party-sizes 2,3,4` (a new
`bossRounds` column in the party summary: rounds from a boss's first sight to its death): boss fights
should last about as many rounds per player as in single player, with **fell** staying within a few
points of MP1's 19–24 %. `balance/static.ts` (single player) is untouched.

**c. Exit countdown**: no engine change; rooms pass `exitCountdownTurns: 10` (§4).

## 11. Scripted client and exit-check tests

`tests/net/scripted-client.ts`:

```ts
interface ScriptedOptions { url: string; origin: string; room: string; name: string; colour: string;
  token?: string; engine?: string;                 // default ENGINE_VERSION; 'old' for the outdated test
  bot?: BotName;                                   // decides on the client's own replica (sim bots)
  chatEvery?: number;                              // a chat line every k entries
  fault?: { delayMs?: [number, number]; drop?: number; seed: number };   // both directions
  now?: () => number }
class ScriptedClient { connect(): Promise<Welcome>; state: GameState; pid: PlayerId; n: number;
  chats: ChatLine[]; refusals: Refused[]; desyncs: number; play(entries: number): Promise<void>;
  drop(): void; reconnect(): Promise<Welcome>; close(): Promise<void> }
```

It wraps `RoomClient` with a `ws` socket factory. The bot sends one turn action per ready turn with
`intent: 'decide'` (or `'travel'` for moves along a path it planned), free actions as they come, and
`typing` before each chat line. `FaultyChannel` delays every frame by a seeded random time in `delayMs`
and drops a share `drop` of frames (inputs, chat and hash reports out; entries in), so ordering, gap
sync and snapshots are exercised. `tools/room-bots.ts --url … --room … --bots 4` runs the same clients
against a live server by hand.

Exit-check tests (`tests/server/rooms-*.test.ts`, server on port 0 with a temp `ANYWORLD_DATA_DIR`,
`fixture-western`, fast clock options: deadline 300 ms, travel 20 ms, countdown turn 50 ms):

| Test | Checks |
|---|---|
| `rooms-play` | 4 clients join, the host starts, 400 entries with chat every 25: every client's `hashState` equals the server's, no desync snapshots, chat history identical and in order (≤ 100), typing produced busy entries, a GM `intro` / `area_enter` entry arrived, at least one area change |
| `rooms-restart` | a child process (`tsx server/index.ts`, env `PORT=0` printed on stdout) is `SIGKILL`ed mid-run, restarted on the same data dir; the clients reconnect with their tokens, get the missing entries or a snapshot, play 100 more entries and agree on the hash; the log replay is checked against an uninterrupted run of the same entries |
| `rooms-version` | restart with another engine version: the room file is gone, reconnects get `room_closed / server_updated`, `/api/rooms` is empty |
| `rooms-outdated` | `hello { engine: 'old' }` → `refused outdated, reload: true`; `POST /api/rooms` with an old engine → 409 |
| `rooms-reconnect` | a client drops: roster `off`, a busy entry, turns go on without waiting for it; reconnect within 2 min: same pid; with an injected clock past 2 min: `leave` entry, its items on the floor, seat `gone`; reconnect → `return` |
| `rooms-faults` | 4 clients with delay 20–250 ms and 5 % loss each way, 300 entries: no crash, every client ends on the server's hash (snapshots allowed and counted), the deadline resolved turns that lost inputs |

Focused unit tests: `tests/net/protocol.test.ts` (every message parses, bounds, unknown `t`, sizes),
`tests/net/log.test.ts` (`applyEntry` replay equals the direct engine calls; a `runParty`-style loop
through entries ends on the same hash), `tests/server/rooms-clock.test.ts` (`nextResolve` table:
all acted, travel cadence, deadline, idle and busy players, countdown, area hold, nothing pending),
`tests/server/rooms-store.test.ts` (atomic write, torn last line, snapshot then truncate, broken file,
tombstones), `tests/server/rooms-limits.test.ts` (Origin, frame size, rates, room/IP limits, invalid
counts), `tests/server/rooms-room.test.ts` (Room with fake connections: seats, host hand-over, phases,
play again, chat rules), `tests/engine/party-leave.test.ts`, `tests/engine/party-bosses.test.ts`.

## 12. Build plan

Each step ends with `npx tsc --noEmit -p .` clean, its focused tests, the full `npx vitest run`
passing, the golden replay unchanged, and a commit on `multi`.

| Step | Content | Focused tests |
|---|---|---|
| C1 | **Engine**: `leaveMap` / `returnToMap` (§10a), boss scaling (§10b) with the sim `bossRounds` column and tuning; `src/gm/offline.ts` moved out of the client with re-exports (§6) | `party-leave`, `party-bosses`, the client GM tests unchanged; `--party-sizes 2,3,4 --seeds 10` (0 crashes, fell within a few points of MP1), `--gate --seeds 40` passes on all 21 worlds |
| C2 | **Shared net**: `ws` dependency; engine version (§8) for vite, vitest and the server, `/api/health.engine`; `src/net/protocol.ts`, `src/net/log.ts`, `src/net/version.ts`; en/nb strings | `protocol`, `log`, version agreement test |
| C3 | **Room core**: `server/rooms/clock.ts`, `room.ts` (seats, roster, phases, turn clock, chat, typing, GM entries, hashes, 2-minute rule, host hand-over), `store.ts`, `worlds.ts`, `manager.ts` (limits, idle sweep, load and replay, version closing); transport-agnostic (`Conn` interface), injected clock and timers | `rooms-clock`, `rooms-room`, `rooms-store` |
| C4 | **Network**: `server/rooms/ws.ts` on the existing server (Origin, per-IP and per-connection limits, pings, `hello` timeout), HTTP routes in `app.ts`, `data-dir.ts` and start-up failure, shutdown, dev proxies with `ws: true`; `src/net/client.ts` (`RoomClient`); `.gitignore` `.data/`; HOSTING.md and `deploy/anyworld.env.example` (`ANYWORLD_DATA_DIR`, `ANYWORLD_MAX_ROOMS`) | `rooms-limits`, a smoke join over a real socket, existing `server` tests unchanged |
| C5 | **Scripted client and exit checks**: `tests/net/scripted-client.ts`, `FaultyChannel`, `tools/room-bots.ts`; the six exit-check tests (§11); `docs/progress/MP2.md`; plan status | `rooms-play`, `rooms-restart`, `rooms-version`, `rooms-outdated`, `rooms-reconnect`, `rooms-faults`; then the full suite and the gate |

## Constants

| Name | Value | Where |
|---|---|---|
| `MAX_ROOMS` | 10 (env `ANYWORLD_MAX_ROOMS`) | manager |
| `DEFAULT_MAX_PLAYERS` / max | 8 / 12 (`MAX_PARTY_SIZE`) | room options |
| `DEFAULT_DEADLINE_MS` | 2000 (1000–5000) | room options |
| `TRAVEL_MS` | 100 | clock |
| `COUNTDOWN_TURN_MS` / `EXIT_COUNTDOWN_MS` | 1000 / 10 000 → `exitCountdownTurns` 10 | clock, run creation |
| `AREA_HOLD_MAX_MS` | 3000 | clock |
| `IDLE_ACTIVE_MS` | 10 000 | room |
| `AWAY_MS` | 120 000 | room |
| `IDLE_MS` / `EMPTY_MS` | 2 h / 15 min | manager |
| `CHAT_HISTORY` / `CHAT_MAX` / chat rate | 100 / 200 / 1 per s | room |
| `SNAPSHOT_EVERY` / ring buffer / hash ring | 100 / 512 / 64 | room, store |
| `HASH_EVERY` | 10 | client |
| `maxPayload` / room body | 16 KB / 1 MB | ws, app |
