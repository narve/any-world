# MP1 — Engine: parties (design)

Date: 2026-10-26. Branch `multi`. Scope: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3 row MP1, with the
owner decisions of §1, §2.1 and §6. Engine and bots only: no room server, WebSocket, lobby or chat UI
(MP2/MP3). Single player is a party of one and plays exactly as today (same states for the same seed
and actions; `tests/sim/fast.test.ts` parity and every current test keep passing).

## 0. Size of the change (measured on `1f9378f`)

| Use | Engine (non-test) | Client / sim / server | Tests |
|---|---|---|---|
| `s.player` / `state.player` | 119 in 24 files (inventory 23, gm-context 10, npc 7, index 7) | session 32, view 13, game-controller 8, guide 6, lighting 8; bots 13, run 15 | ~390 in 68 files |
| `playerActor(ctx)` | 53 (inventory 10, actions 6, gm 5) | fast 1 | — |
| `isPlayer(ctx, …)` | 54 | — | — |
| `pendingChoice` | 16 (npc 6, gm 5, legal 3) | 49 (session 26) | 57 |
| `area.seen` | 33 (all `src`) | (included) | 38 |
| `world.player.name` in log params | 25 | — | 1 |
| `player.currency` / `mercyUsed` / `knowledge` | 10 / 5 / 9 | | 29 / 6 / 5 |

Most engine code acts for "the player" in the middle of one action. The design keeps that code as it
is by making "the player" mean **the acting player** of the context (§1.3); only the turn loop, AI,
vision, conditions, death and area entry loop over the party. Expected diff: ~1.5k lines engine,
~300 client, ~400 sim/tools, ~600 tests (mostly mechanical renames in B1).

## 1. Data model

### 1.1 Types (`src/engine/types.ts`)

```ts
export type PlayerId = string;              // "p1", "p2"… (engine-assigned in join order)

export interface PlayerState {              // was the run-wide PlayerState; now one per player
  id: PlayerId;
  name: string;                             // world.player.name for a party of one; chosen name in rooms
  color?: string;                           // client tag colour (MP3), engine ignores it
  actorId: string;
  slots: (ItemInstance | null)[];
  equipped: { weapon: number | null; armour: number | null; trinket: number | null };
  level: number; xp: number; perks: string[];
  pendingPerkChoice: string[] | null;
  resources: Record<string, number>;        // bodily: oxygen, heat, sanity… drain per player
  sneaking: boolean;
  knowledge: Record<string, ItemKnowledgeState>;   // moved from GameState
  pendingChoice: PendingChoice | null;      // moved from GameState: dialogue, trade, GM offer
  seen: Uint8Array | number[];              // moved from AreaState: this player's fog for the current area
  mercyUsed?: boolean;                      // moved from GameState: this player's second chance is spent
  down?: { since: number; helpedTurns: number } | null;   // §4
  busy?: boolean;                           // typing / in a menu (set by inputs, §2.2); pendingChoice also counts
  lastHarm?: GameState['lastHarm'];         // moved from GameState: the loss line names this player's last harm
}

export interface GameState {
  version: 2;                               // bumped: old saves fail to load, the client starts a new game
  …
  players: Record<PlayerId, PlayerState>;
  party: PlayerId[];                        // join order; the base of the resolution order
  purse: number;                            // shared currency (was player.currency)
  // removed: player, knowledge, pendingChoice, mercyUsed, lastHarm (now per player)
  …
}

export interface AreaState {
  … // `seen` moves to PlayerState; discoveredRegions stays shared (GM hooks, union of all players)
  exitCountdown?: { turnsLeft: number; by: PlayerId } | null;   // §5
  partySize?: number;                       // the party size this area was built for (§6)
}

export interface ActorInstance { … ai: { …; targetId?: string } }   // sticky player target (§3)
```

**Shared** (on GameState / AreaState, as today): area map, actors, floor items, flags, counters,
quests, `defeated`, `stats`, GM budget and rules, `activeRules`, log, `turn`, `rng`, `nextId`,
`uniquesSpawned`, `difficulty`.

**Per player**: everything in `PlayerState` above.

### 1.2 Decisions and why

- **Currency is shared (`GameState.purse`).** Fast and fun: no "give me 5 gold" transfers, no UI for
  them, no loot races over coins; buying becomes a chat moment ("do we buy the lamp?"). Trades,
  GM `currency` actions and `sell` all use the purse. Items stay personal (inventory is the
  character), passed on by drop / pickup in MP1.
- **XP is shared in full**: every player gets each kill's XP (not split). Nobody falls behind, no kill
  stealing; party scaling (§6) pays for it. Level-up perk choices stay per player and are free actions.
- **Knowledge is per player, appearances are shared**: `initKnowledge` rolls the appearance table once
  and every player starts with a copy, so "the blue vial" is the same item for everyone and players can
  tell each other in chat what it did. Learning on use teaches only the user (MP4 may add "told").
- **Fog is per player** (each client shows its own player's memory); `discoveredRegions` stays shared.
- **Allies** belong to the player who recruited or summoned them (`allyOf` = that player's actorId, as
  today) and follow that player.

### 1.3 Acting player in the context (`src/engine/ctx.ts`)

```ts
interface Ctx { …; pid: PlayerId; fovCache?: Map<PlayerId, FovCacheEntry> }

export function me(ctx: Ctx): PlayerState                    // ctx.s.players[ctx.pid]
export function playerActor(ctx: Ctx): ActorInstance         // unchanged signature: the acting player's actor
export function playerActorOf(ctx: Ctx, pid: PlayerId): ActorInstance | undefined
export function playerOf(ctx: Ctx, a: ActorInstance | null | undefined): PlayerState | undefined
export function isPlayer(ctx: Ctx, a): boolean               // any party member's actor (was: the one player)
export function partyActors(ctx: Ctx): ActorInstance[]       // standing (not down) player actors, party order
export function withPlayer<T>(ctx: Ctx, pid: PlayerId, fn: () => T): T   // sets ctx.pid, restores it
export function playerName(ctx: Ctx, pid = ctx.pid): string // replaces the 25 `world.player.name` log params
```

`makeCtx` sets `pid = env.playerId ?? state.party[0]`. `EngineEnv` gains `playerId?: PlayerId`, so every
read query (`legalActions`, `playerSheet`, `describeInventory`, `describeItem`, `transitionBlocker`,
`persuadeOdds`) answers for a chosen player and defaults to the lead player. Engine code that reads
`ctx.s.player.X` becomes `me(ctx).X` (mechanical); code that runs for everyone (end of round,
FOV, area entry, checkEnd) loops `for (const pid of ctx.s.party) withPlayer(ctx, pid, …)`.
Effects from a non-player source that touch a player actor (a hostile's drain on a resource, a
`has_item` check on the target) resolve the player through `playerOf(ctx, actor)`, not `ctx.pid`.

New exports from `index.ts`: `leadPlayer(state): PlayerState` (= `players[party[0]]`; tests and the
client use it), `playerIds(state)`, `addPlayer(state, { name, color? }): { state, playerId }` (pure;
places the newcomer next to the lead at the next free tile, level 1 with the world's starting kit;
needed by MP2 late joiners, cheap to have now). `NewGameOptions.players?: { name: string; color?: string }[]`
(default: one player named `world.player.name`).

### 1.4 Save, clone

`serialize` packs every `players[*].seen` as today's digit string; `deserialize` rejects `version !== 2`
("unsupported save version", which the client already turns into a new game). `clone.ts` copies each
player's `seen` like `area.seen` today. No migration code.

## 2. Turn API

### 2.1 Signatures (`src/engine/index.ts`, core in new `src/engine/party.ts`)

```ts
export interface TurnInput {
  playerId: PlayerId;
  action?: PlayerAction;                    // absent = just a busy flag update
  busy?: boolean;                           // typing / in a menu (server sets it, §2.1 of the plan)
}
export interface TurnResult extends StepResult {
  /** per input, in input order */
  outcomes: { playerId: PlayerId; ok: boolean; tookTurn: boolean; reason?: string }[];
  /** players who could have acted (energy ≥ ACT_COST, standing) but sent no turn action: they waited */
  waited: PlayerId[];
}
export function stepTurn(state: GameState, inputs: TurnInput[], env?: EngineEnv): TurnResult;
export function readyPlayers(state: GameState): PlayerId[];   // standing, energy ≥ ACT_COST, not stunned
export function step(state, action, env?): StepResult;        // = stepTurn(state, [{ playerId: env?.playerId ?? party[0], action }])
```

`fastStep` (sim) and `step` share one in-place core `runTurn(ctx, inputs)` in `party.ts`, so they cannot
drift (fast.test.ts keeps checking `step` vs `fastStep`, and adds a `stepTurn` 3-player parity case).

### 2.2 Resolution order (deterministic)

1. **Busy flags** from all inputs are applied first.
2. **Free actions** (outcome `free()`: `talk`, `choose_option`, `choose_perk`, `toggle_sneak`, and the
   inventory moves that are free today), in **input order**, each with `ctx.pid` = its player. A player
   may send several free actions and at most one turn action in one call.
3. **Turn actions**, at most one per player, in the **rotated party order**: `party` rotated by
   `turn % party.length` (fair first-mover on contested tiles; a party of one is unaffected). Each is
   validated against the state as it is at its moment; a refused one (target gone, tile now taken)
   becomes `ok: false` and that player waits. A player with energy `< ACT_COST` or down is refused
   ("not ready"). The cost is taken from that player's actor energy as `step` does today.
4. If **no turn action succeeded**, the world does not move (dialogue choices never cost a party turn,
   and a party that only chats loses nothing). Otherwise every **ready player without a turn action**
   waits (`energy -= ACT_COST`, listed in `waited`), then `runWorld`.
5. `checkEnd`, `updateFov` for every player, rng saved.

### 2.3 Energy and speed

`runWorld` keeps its shape; "the player can act again" becomes "**some standing player** has
`energy ≥ ACT_COST`" (stunned players burn their 100 and log as today). Hasted players get extra
actions exactly as in single player: after a party turn, a hasted player may still be ready while the
others are not; the next `stepTurn` takes only their input, and the others are not ready (not "waited").
Slowed players are skipped on the turns they lack energy. Energy is capped at 400 as today; waiting
spends energy, so idle players do not bank bursts. `readyPlayers` lets the server (MP2) know whose input
it waits for.

### 2.4 Pending choices

Per player: a dialogue or trade blocks only its own player (`doPlayerAction` checks `me(ctx)`), never
pauses anyone. `applyGmActions(state, actions, env)` puts an `offer_choice` on `env.playerId ?? lead`
(MP4 targets players); `currency` goes to the purse.

## 3. Enemy AI among players (`src/engine/ai.ts`)

- **Perception per target player**: `noticeRadius` halves for a sneaking target using
  `playerOf(ctx, target).sneaking`. Down players are not actors to perceive (hp 0, §4).
- **Target choice**: `nearestEnemy` as today (all player-side actors, nearest by distance², ties by
  actor order). Then **stickiness between players**: if the nearest is a player and `a.ai.targetId`
  names another player actor that is still perceivable, standing and not busy, and at most 2 tiles
  farther (Chebyshev) than the nearest, keep it. The pick is stored in `ai.targetId`. With one player
  the result equals today's choice.
- **Busy players** (`busy` or a `pendingChoice` open): never targeted for a **new attack**. A hostile
  whose best target is busy picks the nearest non-busy one; if all are busy it still closes in
  (`stepToward`) but does not call `performAttack` and skips offensive abilities whose resolved targets
  include a busy player. Damage already in flight (statuses, terrain, an area effect aimed at someone
  else) still applies. In single player a dialogue never lets the world run, so nothing changes.
- **Symmetric perception per player**: `playerSeesTile(ctx, pos)` becomes `playerSeesTile(ctx, pid, pos)`
  with a per-player FOV cache; `combat.ts:84` and `ai.ts:189` check **the targeted player** (a hostile
  never hits a player from beyond arm's reach from a tile *that* player cannot see).
  `isVisibleToPlayer(ctx, a)` reads `me(ctx).seen` (the acting player). GM spawn placement "out of
  view" (`gm.ts:63`) must be out of view of every player.
- **Allies** follow and defend their owner (`playerOf` of `allyOf`), not the lead player.

## 4. Falling, second chance, revive, party loss (`combat.ts`, `turn.ts`)

`killPlayer(ctx, victim, killerId)` takes the victim's actor:

1. **Second chance** if `!ps.mercyUsed` and (`permadeathMercy` rule, or `profile.secondChance`
   (Gentle, as today), or **party size ≥ 2 and difficulty is gentle or normal** — new
   `DifficultyProfile.partySecondChance`: true for gentle and normal). Up at half health, `log.mercy`.
   A party of one keeps today's rule (no second chance on Normal), so single-player balance and the
   new-player gate are untouched.
2. Otherwise the player is **down**: `hp = 0`, `down = { since: turn, helpedTurns: 0 }`, statuses,
   temp mods and pending choice cleared, energy 0, sneaking off; the actor stays in `area.actors`
   (`isAlive` is false at hp 0, so hostiles ignore it and others can step over it: `actorAt` already
   skips hp ≤ 0). Event `{ type: 'downed', playerId }`, log `log.party.down`.
3. **Revive** in `endRound`: a down player with a standing teammate adjacent (Chebyshev ≤ 1) at the end
   of a round gets `helpedTurns += 1`; at 1 (one turn), or when `turn - since ≥ 20`, they get up at half
   health (`REVIVE_HELP_TURNS = 1`, `REVIVE_SELF_TURNS = 20`), on their tile or `findFreeNear` if taken,
   energy `ACT_COST`. Event `revived`, log `log.party.up`. A down player never spends a second chance.
4. **Loss** (`checkEnd`): the run is lost only when **every** player is down at once; the loss reason
   names the last fall. A party of one: the first non-mercy fall is a loss, exactly as today.
5. Hard and Brutal: no second chance in a party; the first fall is a down (revive rules as above).

**Win / lose conditions with several players** (`conditions.ts`, `checkEnd`, `area.transitionFailure`,
`gm.checkQuests`). `who: 'player'` and the default `self` mean the acting player inside an action;
the run-level evaluations iterate the party:

| Evaluation | Rule |
|---|---|
| `goal.win`, `transitionRequires`, quest `complete` | **any** standing player satisfies it (`has_item` in anyone's pack, `stat`, `on_terrain`, `has_status`) |
| `goal.lose` | **every** player satisfies it (global ones — flag, counter, turn, in_area — are the same for all; a personal one like "cursed" loses only if all are) |
| `has_item` with `who: 'self'` in an item/terrain trigger | that actor's player |
| fatal resources (`onEmpty`) | per player: harm that player (may down them) |

Helper: `anyPlayer(ctx, c)` / `allPlayers(ctx, c)` in `conditions.ts`, each `withPlayer` + `{ self: actor }`.

## 5. Area transitions (`area.ts`, `actions.ts doTransition`)

- `transition` by a player on the exit (lock checked as today, with `anyPlayer`):
  - **Party of one, or every other standing player already on/next to the exit**: enter the next area
    now (single player unchanged).
  - Otherwise start `area.exitCountdown = { turnsLeft: EXIT_COUNTDOWN_TURNS, by }` with
    `EXIT_COUNTDOWN_TURNS = 5` (the plan's 10 s at the 2 s default deadline; travel cadence makes it
    shorter in real time). Log `log.party.exit_countdown` ("The party moves on in 5"), event
    `exit_countdown`. The action costs a normal turn. Later `transition` inputs during the countdown
    just count down with it.
- `endRound` decrements it; at 0, or when every standing player stands within 1 tile of the exit,
  `enterArea` runs. **Everyone is pulled along**, down players included: they arrive standing at half
  health (a new area is a fresh start; `mercyUsed` stays spent).
- **Placement**: the player who started the countdown on `map.start`; the others in party order on
  `nearestFreeFloor` (BFS from start, so nobody lands behind a wall); then allies of each player within
  4 tiles of their owner (today's rule per owner). Every player's `seen` is reset to the new map size,
  `exitCountdown` and `ai.targetId` cleared. The one-off `on_area_enter` trigger fires once, with the
  lead player as user. `stats.areasCleared` +1 once per area.

## 6. Party scaling (`src/engine/difficulty.ts` table, used by mapgen and `area.ts`)

```ts
export const PARTY_SCALING = {
  mapArea: 0.15,        // +15 % map area per extra player
  hostileCount: 0.35,   // spawn-table minimums and extra spawns
  hostileHp: 0.15,      // ordinary hostiles
  uniqueHp: 0.5,        // bosses (they face the whole party's focus fire)
  itemCount: 0.5,       // plan.itemCount (packs are personal)
  gmBudget: 0.25,
  actorCap: 10,         // MAX_AREA_ACTORS + 10 per extra player
};
export function partyFactor(n: number, k: number): number   // 1 + k·(n−1); exactly 1 for n = 1
```

- **Map size**: `MapGenerator` gets an optional 4th argument `opts?: { partySize?: number }`;
  `generateArea` passes it to `makeContext(plan, rng, partySize)`, which scales `MAP_SIZES` width and
  height each by `√(1 + 0.15·(n−1))`, rounded (12 players: large 56×40 → 91×65). Knobs derived from
  `size` (shortcuts, spurs, room counts) keep their `bySize` values; generators that size rooms from
  `g.width/height` grow naturally. `area.partySize` records it. Injected maps (`opts.map`, tests) are
  used as given.
- **Hostiles**: `placeActors` multiplies entry minimums (`round`) and `EXTRA_SPAWNS` by
  `hostileCount`; `placed` actors (story, uniques) stay single. `scaledHostileHp(s, def)` multiplies by
  `hostileHp` / `uniqueHp` of the party size; NPCs unchanged. Also used by GM spawns and transforms.
  The actor cap grows by `actorCap`.
- **Items**: `plan.itemCount × itemCount`; `placedItems` (keys, goal items) single.
- **GM budget**: `GM_BUDGET_PER_AREA × gmBudget` (MP4 retunes).
- Party size = `state.party.length` at area entry (late joiners count from the next area).
  All factors are 1 for a party of one: single-player maps, spawns and hp are bit-identical.
  B4 tunes the constants from bot win rates (target: 2–4 player win rate within ±15 points of solo).

## 7. Determinism and hashing (`src/engine/hash.ts`)

```ts
export function hashState(state: GameState): string   // 16 hex chars
```

FNV-1a over a canonical walk of the state: object keys **sorted**, arrays in order, typed arrays
(`seen`) as their bytes, numbers via `String(n)`, `undefined` keys skipped (so a missing and an
absent-but-declared optional field hash alike). Two 32-bit lanes (`Math.imul`) give 64 bits without
BigInt. Covers the whole state including the log; the world is identified by `worldId`. Cost target:
< 2 ms for a 12-player large area (it runs every 10 turns, MP2). Tests: equal for `cloneState`,
`serialize`/`deserialize` round trip and for `step` vs `fastStep`; differs after any mutation of a
tile, an item, a flag or one player's `seen`. The engine stays free of Date/Math.random; the new code
uses `ctx.rng` only, and party order is the only ordering source besides actor order.

## 8. Bots and sims

- `Bot.decide(state, world, mem, playerId)`; `botCtx(world, state, playerId)` sets `ctx.pid`; the
  13 `s.player` uses in `bots.ts` and helpers in `sim/view.ts` read `me(ctx)`. Single-player
  `runGame` passes the lead id (results unchanged).
- **`src/engine/sim/party.ts`**: `runParty(world, seed, bots: (Bot | BotName)[], opts: RunOptions &
  { timing?: boolean }): PartyResult`. Per party turn: for each ready player in party order, let its
  bot decide; free actions are applied at once through `stepTurn` with that single input (cap 8 per
  player per turn, like today's free-action loop); then one `stepTurn` with every player's turn
  action. Busy is simulated by the `talker` persona (busy while its dialogue is open, which the engine
  already counts). Down players' bots send nothing. Outcome detection reuses `runGame`'s
  (won / lost / stuck after no progress for the stall window / timeout / crash) and
  `invariantError`, extended: every player's actor is in `area.actors` exactly once, down ⇔ hp 0,
  `party` and `players` keys agree, `seen` lengths match the map, exitCountdown ≤ 5.
  With `timing`, it records `stepTurn` wall time per turn (the only non-engine clock, in sim code).
- **`tools/sim.ts`**: `--party <n>` (party size; bots cycle through `--bots`), `--party-sizes 2,3,4`,
  `--timing` (mean / p95 / max ms per party turn in the summary). Summary rows gain party size.
- **MP1 exit checks** (recorded in `docs/progress/MP1.md`):
  1. `npx tsx tools/sim.ts --party-sizes 2,3,4 --seeds 10 --bots explorer,cautious,talker --jobs 6`
     over all 21 worlds: 0 crashes, 0 `stuck`, 0 invariant errors, 0 refused legal actions.
  2. `npx tsx tools/sim.ts --world <one world> --party 12 --seeds 1 --timing`: a full run with 0 crashes
     and no soft-lock; turn times reported (budget: p95 < 20 ms on the dev laptop).
  3. Single player: `--gate --seeds 40 --jobs 6` unchanged from before MP1.

## 9. Client (single player, minimal)

No multiplayer UI. `Session` keeps `readonly playerId = state.party[0]` and a getter `me` (=
`state.players[playerId]`); its 32 `state.player` uses, the 26 `pendingChoice` uses and
`view.ts`, `guide.ts`, `game-controller.ts`, `map-overlay.ts`, `travel.ts`, `render/lighting.ts`,
`render/camera.ts`, `audio-*`, `gm-director.ts`, `gm-recheck.ts` read `me.*`; fog reads `me.seen`;
currency reads `state.purse`. Engine queries need no change (they default to the lead player).
`storage.ts`: a version-1 save fails `deserialize` and the existing fallback starts a new game. Client
tests (`tests/client`, `tests/ui`, `tests/render`) and the e2e smoke keep passing. `src/client/dev/fixtures.ts`
builds version-2 states.

## 10. Build plan

Every step ends with `npx tsc --noEmit -p .` clean, the full `npx vitest run` green, the sim gate
unchanged for single player, and a commit on `multi`.

### B1 — Data model, acting player, hash (no behaviour change)

Scope: §1 and §7. `PlayerState`/`GameState` v2 (`players`, `party`, `purse`; knowledge, pendingChoice,
seen, mercyUsed per player), `ctx.pid`, `me`, `withPlayer`, `playerOf`, `isPlayer` over the party,
`playerName` in log params, `EngineEnv.playerId`, `leadPlayer`, `NewGameOptions.players`, `addPlayer`,
serialize/clone, `hashState`. All loops still run for the single lead player only where turn logic is
concerned (multi-player rules come in B2), but `createGame` can already build N players (placed with
`nearestFreeFloor`). Client and bots/sims adapted to the lead player. Tests migrated mechanically
(`state.player` → `leadPlayer(state)`, `state.pendingChoice` → `leadPlayer(state).pendingChoice`,
`area.seen` → `leadPlayer(state).seen`, `player.currency` → `purse`).
Files: `engine/types.ts, ctx.ts, index.ts, serialize.ts, clone.ts, hash.ts (new), knowledge.ts,
inventory.ts, actions.ts, npc.ts, gm.ts, gm-context.ts, legal.ts, progression.ts, effects.ts, stats.ts,
conditions.ts, combat.ts, turn.ts, vision.ts, area.ts, describe.ts, triggers.ts, rules.ts, actors.ts,
sim/*.ts, client/* (§9)`, tests.
New tests: `tests/engine/party-model.test.ts` (createGame with 1 and 3 players: ids, actors, shared
appearances, purse; `addPlayer`; serialize round trip of 3 players; v1 save refused),
`tests/engine/hash.test.ts` (§7).

### B2 — Turn API, AI among players, falling and revive

Scope: §2, §3, §4. `party.ts` with `runTurn`/`stepTurn`/`readyPlayers`; `step` and `fastStep` on top of
it; `runWorld` "some standing player ready"; `endRound` per-player upkeep (item cooldowns, regen,
resources, revive); FOV for every player; per-player `playerSeesTile`; AI sticky target, busy players,
per-player sneaking; allies follow their owner; shared XP; `killPlayer` → second chance / down;
`partySecondChance`; `checkEnd` with all-down loss and `anyPlayer` / `allPlayers`; transition lock and
quests with `anyPlayer`; log keys `log.party.*` (en + nb catalogs); events `downed`, `revived`.
Files: `engine/party.ts (new), index.ts, turn.ts, actions.ts, ai.ts, combat.ts, vision.ts,
conditions.ts, area.ts (lock only), gm.ts, progression.ts, difficulty.ts, log-keys.ts, types.ts,
sim/fast.ts`, i18n catalogs.
New tests: `tests/engine/party-turn.test.ts` (resolution order and rotation, free actions do not move
the world, idle ready players wait, contested tile, hasted player acts twice, step ≡ stepTurn with one
player), `party-ai.test.ts` (nearest + sticky target, busy player not attacked but approached,
symmetric perception per player, sneaking per player), `party-fall.test.ts` (second chance per player
on gentle/normal, none on hard, down → revived by neighbour after 1 turn or alone after 20, all down =
lost, solo normal unchanged), `party-goals.test.ts` (has_item win by any player, lose needs all);
`tests/sim/fast.test.ts` 3-player parity.

### B3 — Area transitions and party scaling

Scope: §5, §6. Exit countdown (`EXIT_COUNTDOWN_TURNS = 5`), early entry when everyone is at the exit,
everyone pulled along (down players revived), party placement at the new start, allies per owner;
`PARTY_SCALING` and `partyFactor`; `MapGenerator` 4th argument and `makeContext` partySize; spawn
counts, hostile/unique hp, item count, GM budget and actor cap by party size; `area.partySize`.
Files: `engine/area.ts, actions.ts, turn.ts, difficulty.ts, actors.ts, gm.ts, types.ts,
mapgen/context.ts, mapgen/index.ts` (and generators only where they hard-code dimensions),
`log-keys.ts`.
New tests: `tests/engine/party-exit.test.ts` (countdown start, count down, early entry, pull-along with a
down player, placement: all on free reachable floor, lock checked against any player, solo transition
immediate), `tests/engine/party-scaling.test.ts` (factors 1 for n = 1 with identical maps/spawns as
before, growth for n = 2/4/12, caps), `tests/mapgen/party-size.test.ts` (every generator at
party sizes 1, 4, 12: valid, connected, start ≠ exit, dimensions as specified; timing kept loose).

### B4 — Party bots, sim tool, exit checks, tuning

Scope: §8. `Bot.decide(…, playerId)`, `sim/party.ts runParty`, extended `invariantError`,
`tools/sim.ts --party / --party-sizes / --timing`, summaries per party size; run the MP1 exit checks;
tune `PARTY_SCALING` from 2–4 player win rates; write `docs/progress/MP1.md` (checks, numbers, known
limits) and update the plan's status line.
Files: `engine/sim/party.ts (new), bots.ts, view.ts, run.ts, index.ts`, `tools/sim.ts`,
`src/engine/difficulty.ts` (constants), docs.
New tests: `tests/sim/party.test.ts` (2-player and 4-player runs on two fixture worlds finish without
crash or stuck, deterministic for a seed, bots never mutate the state, `timing` produces numbers),
a short 12-player smoke (`tests/sim/party-12.test.ts`, capped turns).
