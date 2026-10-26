# MP1 — Engine: parties (design)

Date: 2026-10-26 (revised the same day after three reviews, see "Review notes"). Branch `multi`.
Scope: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3 row MP1, with the owner decisions of §1, §2.1
and §6. Engine and bots only: no room server, WebSocket, lobby or chat UI (MP2/MP3). Single player is a
party of one and plays exactly as today (same states for the same seed and actions, checked by a golden
replay test, §10 B0; `tests/sim/fast.test.ts` parity and every current test keep passing).

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

Engine code reads "the player" in two different ways, and the design keeps them apart (§1.3):

- **for the acting player** (action entry points: `actions`, `inventory`, `npc`, `legal`, the describe
  queries): `me(ctx)`, where `ctx.pid` is the player whose input is being resolved;
- **for an actor** (stats, combat, effects, triggers, progression, log names): the player *of that
  actor*, `playerOf(ctx, a)`. These run during AI turns and `endRound` too, where `ctx.pid` has no
  meaning for the actor in hand.

Only the turn loop, AI, vision, conditions, falling and area entry loop over the party. Expected diff:
~1.8k lines engine, ~300 client, ~500 sim/tools, ~700 tests (mostly mechanical, B0).

## 1. Data model

### 1.1 Types (`src/engine/types.ts`)

```ts
export type PlayerId = string;              // "p1", "p2"… (engine-assigned in join order)

export interface PlayerState {              // was the run-wide PlayerState; now one per player
  id: PlayerId;
  name: string;                             // world.player.name for a party of one; chosen name in rooms
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
  busySince?: number | null;                // turn the busy state began (§3); null/absent = not busy
  lastHarm?: GameState['lastHarm'];         // moved from GameState: the loss line names this player's last harm
}

export interface GameState {
  version: 2;                               // bumped: old saves fail to load, the client starts a new game
  …
  players: Record<PlayerId, PlayerState>;
  party: PlayerId[];                        // join order; the base of the resolution order and of every party loop
  purse: number;                            // shared currency (was player.currency)
  partyRules: { exitCountdownTurns: number };   // §5; from NewGameOptions, default 5; in the state so replays agree
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

No cosmetic data (name colour) in the engine: that is roster data for MP2/MP3. Fields are optional
or grouped (`partyRules`) so later milestones can add to them without another version bump.

**Shared** (on GameState / AreaState, as today): area map, actors, floor items, flags, counters,
quests, `defeated`, `stats`, GM budget and rules, `activeRules`, log, `turn`, `rng`, `nextId`,
`uniquesSpawned`, `difficulty`.

**Per player**: everything in `PlayerState` above.

### 1.2 Decisions and why

- **Currency is shared (`GameState.purse`).** Fast and fun: no "give me 5 gold" transfers, no UI for
  them, no loot races over coins; buying becomes a chat moment ("do we buy the lamp?"). Trades,
  GM `currency` actions and `sell` all use the purse; affordability is checked at each choice, in
  resolution order (two trades in one `stepTurn` cannot both spend the same coins). Items stay
  personal (inventory is the character), passed on by drop / pickup in MP1. *Not in the plan: recorded
  as an open owner question in plan §6.*
- **XP is shared in full**: every standing or down player gets each kill's XP and each `grant_xp`
  (effect or GM), not split. Nobody falls behind, no kill stealing; party scaling (§6) pays for it.
  Level-up perk choices stay per player and are free actions. *Not in the plan ("per-player
  levelling" there means each player has their own level and perks, which stays true): recorded as an
  open owner question in plan §6.*
- **Knowledge is per player, appearances are shared**: `initKnowledge` rolls the appearance table once
  and every player starts with a copy, so "the blue vial" is the same item for everyone and players can
  tell each other in chat what it did. Learning on use teaches only the user (MP4 may add "told").
  `obs.self` in learning (effects.ts:436) becomes `target === user`, so a heal on a teammate never reads
  as "You…".
- **Fog is per player** (the engine and bots read it: `reveal_map`, `isVisibleToPlayer`, vision);
  `discoveredRegions` stays shared. `reveal_map` writes the user's `seen`.
- **Allies** belong to the player who recruited or summoned them (`allyOf` = that player's actorId)
  and follow that player. Summons get `allyOf = user.allyOf ?? user.id` (an ally's summon serves the
  same owner). While their owner is down, allies **guard the body**: stay within 2 tiles of it and
  fight hostiles that come close.

### 1.3 Acting player and player of an actor (`src/engine/ctx.ts`)

```ts
interface Ctx { …; pid: PlayerId }

export function me(ctx: Ctx): PlayerState                    // ctx.s.players[ctx.pid]: action entry points only
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
`persuadeOdds`) answers for a chosen player and defaults to the lead player.

**Keyed by actor** (`playerOf(ctx, a)`, never `ctx.pid`):

- `stats.ts`: `activeItems(ctx, ps)`, `modSum`, `getStat` resources: armour AC, max hp, speed in
  `energyGain`, sight radius;
- `combat.ts`: `attackOf` (weapon), `dealDamage` (`lastHarm`, armour wear `damageEquipped`);
- `effects.ts`: `changeResource`, `resourceEmptied`, `grant_xp`, `currency`, `identify`
  (`identifyCarried`), `reveal_map`, `teleport to_exit` (`exitReachable`), `autoTarget` /
  `isVisibleToPlayer` (the user's `seen`), summon `allyOf`;
- `triggers.ts` `triggersFor` (perks, item triggers), `progression.ts` `checkLevelUp`,
  `inventory.ts` `countItem(ctx, ps, …)`, `ctx.ts` `actorName` (each player logs under their name);
- `rules.ts:376/466` (the GM's estimate of a rule's help): per-player `mercyUsed` of the targeted
  player and `profile.partySecondChance` (§4).

`runAction`, `fireTriggers` and `fireItemTriggers` wrap their body in `withPlayer(ctx, playerOf(user).id)`
when the user is a player actor, so the remaining `me(ctx)` reads inside an effect are the user's.

**`who: 'player'`** in `conditions.ts` (and `self` without `cc.self`): inside a player's action, the
acting player; during a hostile's turn, its `ai.targetId`, else the nearest standing player; in the
run-level evaluations, see §4. GM placement (`gm.ts` `nearPos('player')`, `resolveActor`, `effect`)
targets the **lead player in MP1** (MP4 makes the GM party-aware).

New exports from `index.ts`: `leadPlayer(state): PlayerState` (= `players[party[0]]`; tests and the
client use it), `playerIds(state)`, `addPlayer(state, { name }): { state, playerId }` (pure; places the
newcomer next to the lead on the nearest free floor, level 1 with the world's starting kit; MP2 needs
it for late joiners). `NewGameOptions.players?: { name: string }[]` (default: one player named
`world.player.name`) and `NewGameOptions.exitCountdownTurns?: number`.

`createGame` keeps today's rng and id order for the first player (`initKnowledge(world, rng)` before
the kit's `makeItem` ids, `nextId: 2`); extra players are built after, so a party of one is
byte-identical.

### 1.4 Save, clone

`serialize` packs every `players[*].seen` (values 0/1/2) as a **run-length coded** digit string
(`"0x812,1x40,2x9…"`: fog is long runs; a 91×65 map of a 12-player room stays a few KB, not ~70 KB
per player). `deserialize` rejects `version !== 2` ("unsupported save version", which the client
already turns into a new game) and always produces `Uint8Array`. `clone.ts` copies each player's
`seen`. No migration code.

## 2. Turn API

### 2.1 Signatures (`src/engine/index.ts`, core in new `src/engine/party.ts`)

```ts
export interface TurnInput {
  playerId: PlayerId;
  actions?: PlayerAction[];                 // free actions first, at most one turn action (last)
  busy?: boolean;                           // typing / in a menu, only honoured without a turn action (§3)
}
export interface TurnOptions {
  /** the deadline passed (MP2) or the sim forces a turn: ready players without a successful turn
   *  action wait and the world moves even if nobody acted */
  advance?: boolean;
}
export type Refusal = 'not ready' | 'down' | 'contested' | 'stale' | 'area changed' | 'illegal';
export interface TurnResult extends StepResult {
  /** per action, in input order */
  outcomes: { playerId: PlayerId; ok: boolean; tookTurn: boolean; reason?: Refusal }[];
  /** players who could have acted (standing, energy ≥ ACT_COST) but did not take a turn: they waited */
  waited: PlayerId[];
}
export function stepTurn(state: GameState, inputs: TurnInput[], env?: EngineEnv & TurnOptions): TurnResult;
export function readyPlayers(state: GameState): PlayerId[];   // standing, energy ≥ ACT_COST, not stunned
export function step(state, action, env?): StepResult;        // = stepTurn(state, [{ playerId: env?.playerId ?? party[0], actions: [action] }])
```

`fastStep` (sim) and `step` share one in-place core `runTurn(ctx, inputs, opts)` in `party.ts`, so they
cannot drift (fast.test.ts keeps checking `step` vs `fastStep`, and adds a `stepTurn` 3-player parity
case).

### 2.2 Resolution order (deterministic)

1. **Busy** from inputs without a turn action is applied first (sets `busySince = turn` if unset;
   `busy: false` clears it).
2. **Free actions** (outcome `free()`: `talk`, `choose_option`, `choose_perk`, `toggle_sneak`, and the
   inventory moves that are free today), in **input order**, each with `ctx.pid` = its player.
3. **Turn actions**, at most one per player, in the **rotated party order**: `party` rotated by
   `turn % party.length` (fair first-mover on contested tiles; a party of one is unaffected). Each is
   validated against the state as it is at its moment. A refused one gets a reason: `contested` (an
   earlier mover took the tile or the target), `stale` (target gone or out of reach for another
   cause), `area changed` (an earlier input moved the party to a new area: directions and targets are
   stale), `not ready` (energy `< ACT_COST`), `down`, or `illegal` (refused although nothing changed
   since the bot or client read `legalActions`: a bug). A successful turn action clears its player's
   `busySince` (busy only lasts between actions). The cost is taken as `step` does today.
4. If **no turn action succeeded** and `advance` is not set, the world does not move (dialogue
   choices never cost a party turn, and a party that only chats loses nothing). Otherwise every
   **ready player without a successful turn action** waits (`energy -= ACT_COST`, listed in
   `waited`), then `runWorld`. MP2's deadline and the sim's party turn pass `advance: true`, so an
   idle or fully refused party still moves.
5. A pending area change (§5) runs here, after `runWorld` returns; then `checkEnd`, `updateFov`,
   rng saved.

### 2.3 Energy and speed

`runWorld` keeps its shape; "the player can act again" becomes "**some standing player** has
`energy ≥ ACT_COST`". The stunned energy burn loops over every standing player (each burns 100 and logs
as today). **Down players gain no energy** (frozen at 0, so no burst on revive). Hasted players get
extra actions exactly as in single player: after a party turn, a hasted player may still be ready while
the others are not; the next `stepTurn` takes only their input, and the others are not ready (not
"waited"). Energy is capped at 400 as today; waiting spends energy, so idle players do not bank
bursts. `readyPlayers` lets the server (MP2) know whose input it waits for. `computeLegalActions`
returns `[]` for a down player and only free actions for a player with energy `< ACT_COST`.

### 2.4 Pending choices

Per player: a dialogue or trade blocks only its own player (`doPlayerAction` checks `me(ctx)`), never
pauses anyone. In a party the world keeps moving while a choice is open, so:

- **`choose_option` re-checks** that the speaker is alive, not hostile, within `TALK_RANGE`, and that a
  once-only service (`npcUsed`) or a recruit (`speaker.allyOf`) is still available. Otherwise the choice
  closes with `log.party.talk_gone` and nothing is applied.
- **`endRound` closes stale choices**: speaker dead, hostile or out of talk reach. A closed GM offer
  gives back its `reservedBudget`.
- **One open dialogue per NPC**: `talk` to an NPC another player is talking to is refused
  (`log.party.npc_busy`, free action, no turn).

`applyGmActions(state, actions, env)` puts an `offer_choice` on `env.playerId ?? lead` (MP4 targets
players); `currency` goes to the purse.

## 3. Enemy AI among players (`src/engine/ai.ts`)

- **Perception per target player**: `noticeRadius` halves for a sneaking target using
  `playerOf(ctx, target).sneaking`. Down players are not actors to perceive (hp 0, §4).
- **Target choice**: `nearestEnemy` as today (all player-side actors, nearest by distance², ties by
  actor order), skipping busy players. Then **stickiness between players**: if the nearest is a player
  and `a.ai.targetId` names another player actor that is still perceivable, standing and not busy, and
  at most 2 tiles farther (Chebyshev) than the nearest, keep it. The pick is stored in `ai.targetId`.
  With one player the result equals today's choice.
- **Busy players**: a player is busy while `busySince` is set or a `pendingChoice` is open (opening one
  sets `busySince`), for at most `BUSY_MAX_TURNS = 10` turns since `busySince`; after that hostiles
  ignore the flag until the player acts again. A busy player is **never the chosen target** of an
  attack or an ability. If every perceived player is busy, the hostile closes in to Chebyshev 2 and
  waits there (it does not pin a doorway or attack). Area splash of an ability aimed at someone else
  and damage in flight (statuses, terrain) still apply; abilities are never suppressed for a busy
  neighbour. In single player a dialogue never lets the world run, so nothing changes.
- **Symmetric perception per player**: `playerSeesTile(ctx, pos)` becomes `playerSeesTile(ctx, pid, pos)`;
  `combat.ts:84` and `ai.ts:189` check **the targeted player** (a hostile never hits a player from
  beyond arm's reach from a tile *that* player cannot see). GM spawn placement "out of view"
  (`gm.ts:63`), the spawn safety distance and the `area.ts:98` guards consider **every** player.
- **FOV cache per player**: `ctx.fovCache` becomes a map by player id; the stored state per entry
  (tiles array, write stamp, position, radius) already lets `updateFov` skip a player whose position,
  radius and tiles did not change. If B2a's timing shows FOV matters, the cache moves out of the
  per-call context into a module-level `WeakMap` keyed by the map's `tiles` array, so it survives
  across `stepTurn` calls (AI `findPath` is the other likely hot spot).
- **Allies** follow and defend their owner (`playerOf` of `allyOf`), guard the body while the owner is
  down (§1.2).

## 4. Falling, second chance, revive, party loss (`combat.ts`, `turn.ts`, `effects.ts`)

`killPlayer(ctx, victim, killerId)` takes the victim's actor and **does nothing if the victim is
already down** (a second hit in the same turn neither resets `since` nor spends a second chance).
`resourceEmptied` with `emptyIsDeath` goes through `killPlayer` too, never `endGame` directly.

1. **Second chance** if `!ps.mercyUsed` and (`permadeathMercy` rule, or `profile.secondChance`
   (Gentle, as today), or **party size ≥ 2 and difficulty is gentle or normal** — new
   `DifficultyProfile.partySecondChance`: true for gentle and normal). Up at half health, `log.mercy`.
   A party of one on Normal keeps today's rule (no second chance), so single-player balance and the
   new-player gate are untouched. *This is a reading of the owner's "every player on Gentle and
   Normal"; recorded as an open owner question in plan §6.*
2. Otherwise the player is **down**: `hp = 0`, `down = { since: turn, helpedTurns: 0 }`, statuses, temp
   mods and pending choice cleared, `busySince` cleared, energy 0, sneaking off; the actor stays in
   `area.actors` (`isAlive` is false at hp 0, so hostiles ignore it and others can step onto it:
   `actorAt` already skips hp ≤ 0). Event `{ type: 'downed', playerId }`, log `log.party.down`.
   Invariant: down ⇔ hp 0, and down ⇒ no statuses, no temp mods, energy 0.
3. **A down player skips all round upkeep**: regen, resource drain and `onEmpty`, terrain, statuses,
   `on_turn` triggers, energy gain. Every loop in `endRound`, `runWorld`, multi-hit attacks, AoE and
   on-hit triggers checks `isAlive` (audit of `a.hp > 0` vs `isAlive` in B2b).
4. **Revive** in `endRound`: a down player with a standing teammate adjacent (Chebyshev ≤ 1) at the end
   of a round gets `helpedTurns += 1`; at 1 (one turn), or when `turn - since ≥ 20`, they get up at half
   health (`REVIVE_HELP_TURNS = 1`, `REVIVE_SELF_TURNS = 20`), on their tile or `findFreeNear` if taken,
   energy `ACT_COST`. Every **fatal resource** (`onEmpty` harms or `emptyIsDeath`) that is empty is
   refilled to half its maximum, so the player does not fall again at once. Event `revived`, log
   `log.party.up`. A down player never spends a second chance.
5. **Loss** (`checkEnd`): the run is lost only when **every** player is down at once; the loss reason
   names the last fall. A party of one: the first non-mercy fall is a loss, exactly as today.
6. Hard and Brutal: no second chance (owner decision); the first fall is therefore a down, with the
   revive rules above. *Recorded in plan §6 as the reading of "a second fall: down".*

**Win / lose conditions with several players** (`conditions.ts`, `checkEnd`, `area.transitionFailure`,
`gm.checkQuests`). `who: 'player'` and the default `self` follow §1.3 inside an action or AI turn. The
run-level evaluations walk the condition tree **once** and quantify **per leaf**, so compound goals
work (`all(has_item A, has_item B)` with A in p1's pack and B in p2's is won) and `chance` leaves draw
from the rng once:

| Leaf (run level) | Rule |
|---|---|
| `has_item`, `who: 'player'` | counts the **party's packs together**, down players included (a down key-holder does not block an exit) |
| `stat`, `has_status`, `on_terrain` | **any** standing player for `goal.win`, `transitionRequires`, quest `complete`; **all** players for `goal.lose` |
| flag, counter, turn, in_area, chance | global, evaluated once |
| `has_item` with `who: 'self'` in an item/terrain trigger | that actor's player |
| fatal resources (`onEmpty`) | per player: harm that player (may down them) |

`not(…)` keeps its meaning on top of the quantified leaf ("not (any player cursed)"). Helper:
`evalParty(ctx, c, mode: 'win' | 'lose')` in `conditions.ts`. Quest rewards (`checkQuests`,
gm.ts:381): currency to the purse, XP shared (§1.2), items to the player who satisfied the deciding
personal leaf, else the lead.

## 5. Area transitions (`area.ts`, `actions.ts doTransition`, `party.ts`)

- `transition` by a player on the exit (lock checked as today, with the run-level rule of §4):
  - **Party of one, or every other standing player already on/next to the exit**: the area change is
    marked pending and runs at step 5 of §2.2 (single player: same result as today's immediate entry,
    since nothing else happens between).
  - Otherwise start `area.exitCountdown = { turnsLeft: s.partyRules.exitCountdownTurns, by }` (default
    5: the plan's 10 s at the 2 s default deadline; MP2 maps seconds to turns per room and passes
    `exitCountdownTurns`, since the ~100 ms travel cadence makes 5 turns short in real time). Log
    `log.party.exit_countdown` ("The party moves on in 5"), event `exit_countdown`. The action costs
    a normal turn. Later `transition` inputs during the countdown just count down with it. The
    countdown **continues if its starter goes down**.
- `endRound` only decrements it. At 0, or when every standing player stands within 1 tile of the exit,
  it marks the change pending and `runWorld` stops its loop. **`enterArea` never runs inside
  `endRound` or `runWorld`**: `runTurn` calls it after `runWorld` returns, the single path next to
  today's `doTransition`. Inputs later in the same `stepTurn` are refused with `area changed`.
- **Everyone is pulled along**, down players included: they arrive standing at half health with their
  fatal resources refilled as on a revive (a new area is a fresh start; `mercyUsed` stays spent). This
  makes an exit a revive: accepted, it keeps the party moving (fast and fun).
- **Placement**: the starter on `map.start`; the others in party order on `nearestFreeFloor` (BFS from
  start, so nobody lands behind a wall); then allies of each player within 4 tiles of their owner.
  Extra players are placed **before** `placeActors`, as allies are today (`area.ts` ~228), so the solo
  placement order and rng draws stay identical. Every player's energy becomes `max(energy, ACT_COST)`
  (today `doTransition` does this for the acting player only). Every player's `seen` is reset to the
  new map size; `exitCountdown` and `ai.targetId` cleared. The one-off `on_area_enter` trigger fires
  once, with the **starter** as user (the lead when no countdown ran). `stats.areasCleared` +1 once per
  area.

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
export function partyFactor(n: number, k: number): number   // 1 + k·(n−1)
```

For **n = 1 the scaling code is skipped entirely** (no multiplication by 1.0, no rounding), so
single-player maps, spawns and hp are bit-identical.

- **Map size**: `MapGenerator` gets an optional 4th argument `opts?: { partySize?: number }`;
  `generateArea` passes it to `makeContext(plan, rng, partySize)`, which scales `MAP_SIZES` width and
  height each by `√(1 + 0.15·(n−1))`, rounded (12 players: large 56×40 → 91×65, ≈2.6× the tiles).
  Knobs derived from `size` (shortcuts, spurs, room counts) keep their `bySize` values; generators that
  size rooms from `g.width/height` grow naturally. `area.partySize` records it. Injected maps
  (`opts.map`, tests) are used as given.
- **Hostiles**: `placeActors` multiplies entry minimums (`round`) and `EXTRA_SPAWNS` by
  `hostileCount`; `placed` actors (story, uniques) stay single. `scaledHostileHp(s, def)` multiplies by
  `hostileHp` / `uniqueHp` and is used **everywhere `maxHp` is set from a def**: `spawnActor`,
  `transformActor` (unique phases), GM `spawn` and summons (hostile ones). NPCs unchanged. `near_start`
  placement excludes tiles within 3 of any player when n > 1. The actor cap grows by `actorCap`.
- **Items**: `plan.itemCount × itemCount`; `placedItems` (keys, goal items) single.
- **GM budget**: `GM_BUDGET_PER_AREA × gmBudget` (MP4 retunes).
- Party size = `state.party.length` at area entry (late joiners count from the next area).
  B4 tunes the constants from bot win rates (target: 2–4 player win rate within ±15 points of solo).

## 7. Determinism and hashing (`src/engine/hash.ts`)

```ts
export function hashState(state: GameState): string   // 16 hex chars
```

FNV-1a over a canonical walk of the state, two 32-bit lanes (`Math.imul`), 64 bits without BigInt:

- generic walk: object keys **sorted**, arrays in order, numbers via `String(n)`, `undefined` keys
  skipped (a missing and an absent-but-declared optional field hash alike);
- `players` iterated in **`party` order**, never by `Object.keys`;
- every `seen` hashed as its **bytes**, whatever its form (`Uint8Array` or `number[]`, as `deserialize`,
  `fastStep` and `clone` produce different forms);
- a dedicated **tile walker** with a fixed field order for `map.tiles` (≈5.9k tiles at 91×65), instead
  of the sorted-key walk.

Covers the whole state including the log (capped at `MAX_LOG = 200`); the world is identified by
`worldId`. Cost target: < 2 ms for a 12-player 91×65 area (it runs every 10 turns, MP2), measured in
`hash.test.ts` loosely (fail only above 20 ms). Tests: equal for `cloneState`, `serialize`/`deserialize`
round trip (run-length fog, §1.4) and `step` vs `fastStep`; differs after any mutation of a tile, an
item, a flag or one player's `seen`. The engine stays free of Date/Math.random and clocks; the new
code uses `ctx.rng` only, and party order is the only ordering source besides actor order.

## 8. Bots and sims

- `Bot.decide(state, world, mem, playerId)`; `botCtx(world, state, playerId)` sets `ctx.pid`; the
  13 `s.player` uses in `bots.ts` and helpers in `sim/view.ts` read `me(ctx)`. `sim/fast.ts:21`
  converts every player's `seen` to a typed array. Single-player `runGame` passes the lead id
  (results unchanged).
- **`src/engine/sim/party.ts`**: `runParty(world, seed, bots: (Bot | BotName)[], opts: RunOptions &
  { onTurn?: (info) => void; now?: () => number })`. Per party turn: for each ready player in party
  order, let its bot decide; free actions are applied at once through `stepTurn` with that single input
  (cap 8 per player per turn, like today's free-action loop); then one `stepTurn` with every player's
  turn action and `advance: true`. Busy is simulated by the `talker` persona (busy while its dialogue
  is open, which the engine already counts). Down players' bots send nothing. Outcome detection reuses
  `runGame`'s (won / lost / stuck after no progress for the stall window / timeout / crash); a party
  turn where every action was refused is **not** progress. `invariantError`, extended: every player's
  actor is in `area.actors` exactly once, down ⇔ hp 0, down ⇒ no statuses / temp mods / energy,
  `party` and `players` keys agree, `seen` lengths match the map, `exitCountdown.turnsLeft ≤
  exitCountdownTurns`. Refusals are counted by reason (§2.2).
- **Timing without a clock in the engine**: `src/engine` never reads a wall clock. `tools/sim.ts`
  injects `now = performance.now` (and `EngineEnv.profile?: { now(): number; add(key, ms): void }`
  for the split into `ai`, `fov`, `turn`); without it the engine does no timing.
- **`tools/sim.ts`**: `--party <n>` (party size; bots cycle through `--bots`), `--party-sizes 2,3,4`,
  `--timing` (mean / p95 / max ms per party turn, AI and FOV separately). Summary rows gain party size
  and refusals by reason.
- **MP1 exit checks** (recorded in `docs/progress/MP1.md`):
  1. `npx tsx tools/sim.ts --party-sizes 2,3,4 --seeds 10 --bots explorer,cautious,talker --jobs 6`
     over all 21 worlds: 0 crashes, 0 `stuck`, 0 invariant errors, 0 `illegal` refusals (actions that
     were legal at their own moment of resolution); `contested` / `stale` / `area changed` refusals
     reported as numbers.
  2. `npx tsx tools/sim.ts --world <one world> --party 12 --seeds 1 --timing`: a full run with 0 crashes
     and no soft-lock; turn times reported (budget: p95 < 20 ms on the dev laptop).
  3. Single player: `--gate --seeds 40 --jobs 6` unchanged from before MP1, and the golden replay test
     (B0) unchanged.

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
unchanged for single player, the golden replay test unchanged (from B0 on), and a commit on `multi`.

### B0 — Golden replay, accessors (no data change)

Scope: the safety net and the mechanical rename, with `state.player` still in place.

1. First commit: `tests/engine/golden-replay.test.ts`: fixed seeds × 6 worlds (incl. one with fatal
   resources, one with uniques, one with a GM offer), bot runs through `fastStep`, one fingerprint per
   run over a **format-neutral projection** (turn, status, rng, actor ids / positions / hp, `defeated`,
   log text, `seen` bytes), not `serialize` (B1 changes the key layout). Fingerprints committed.
2. Accessors on today's model: `leadPlayer(state)`, `me(ctx)`, `playerOf(ctx, a)`, `playerActorOf`,
   `playerName`, `withPlayer`, `ctx.pid`, `EngineEnv.playerId`, and a test helper `lp(state)`. Move
   engine (both kinds of §1.3: `me` at entry points, `playerOf` for actor-keyed code, incl. `rules.ts`
   and `actorName`), client (§9), sims and the ~430 test uses onto them.

Exit: replay fingerprints identical. Files: `engine/ctx.ts, index.ts` and every engine file using
`s.player`, `sim/*.ts`, `client/*`, tests.

### B1 — Data model v2, hash (no behaviour change)

Scope: §1 and §7, now mostly inside the accessors. `PlayerState`/`GameState` v2 (`players`, `party`,
`purse`, `partyRules`; knowledge, pendingChoice, seen, mercyUsed, lastHarm per player), `isPlayer`
over the party, `createGame` (one player only, rng/id order kept), serialize (run-length fog) / clone,
`hashState`. **`NewGameOptions.players` with n > 1 and `addPlayer` are not public yet** (they arrive in
B2a with the rules that make extra players safe); B1 tests build a second `PlayerState` by hand only
for serialize / clone / hash.
Files: `engine/types.ts, ctx.ts, index.ts, serialize.ts, clone.ts, hash.ts (new), knowledge.ts,
inventory.ts, npc.ts, gm.ts, vision.ts, effects.ts, actions.ts`, `sim/fast.ts`, `client/storage.ts`,
`client/dev/fixtures.ts`, tests.
New tests: `tests/engine/party-model.test.ts` (one-player state shape, shared appearances, purse,
serialize round trip with a hand-built second player, v1 save refused), `tests/engine/hash.test.ts`
(§7, incl. `Uint8Array` vs `number[]` seen and the loose cost check at 91×65).

### B2a — Turn API, party upkeep, minimal party runner

Scope: §2, the multi-player parts of §1.3, and the first slice of §8. `party.ts` with
`runTurn`/`stepTurn`/`readyPlayers`/`advance`; `step` and `fastStep` on top of it; refusal reasons;
busy flag mechanics (set, cleared by a turn action); `runWorld` "some standing player ready" and
stun burn per player; `endRound` per-player upkeep (item cooldowns, regen, resources); FOV for every
player with the per-player cache; `runAction`/`fireTriggers` `withPlayer` wrapping; walking into a
teammate swaps places (unless rooted; `legal.ts` lists it the same way); `computeLegalActions` for
not-ready players; stale-choice checks of §2.4 and one dialogue per NPC; shared purse affordability;
shared XP; `NewGameOptions.players`, `addPlayer` (players placed before `placeActors`).
**Minimal `runParty`** (no CLI flags) and the extended `invariantError`, so every later step is
checked by party runs too. Timing hooks (`EngineEnv.profile`) with a first 12-player measurement on
a large area; fix FOV / pathing hot spots here if p95 > 20 ms.
Files: `engine/party.ts (new), index.ts, turn.ts, actions.ts, legal.ts, npc.ts, vision.ts, triggers.ts,
effects.ts, progression.ts, area.ts (placement only), sim/fast.ts, sim/party.ts (new), sim/run.ts`.
New tests: `tests/engine/party-turn.test.ts` (resolution order and rotation, free actions do not move
the world, `advance` moves an idle party, idle ready players wait, contested tile → `contested`,
hasted player acts twice, step ≡ stepTurn with one player, teammate swap, a hostile hits p2 and p2's
own armour counts, p2's on_turn trigger grants p2's XP / reveals p2's fog), `party-npc.test.ts`
(speaker dies / leaves / turns hostile mid-dialogue → closed, GM offer budget returned, two players and
one NPC, two trades in one `stepTurn` checked against the purse in order), `tests/sim/fast.test.ts`
3-player parity, `tests/sim/party.test.ts` (2 players on two fixture worlds, capped turns: no crash,
invariants hold, deterministic).

**B2a as built** (2026-10-26):
- `src/engine/party.ts` `runTurn` is the one core under `step`, `stepTurn`, `fastStep` and
  `fastStepTurn`. Free actions are the types `talk`, `choose_option`, `choose_perk`,
  `toggle_sneak` (`FREE_ACTIONS`); everything else is a turn action. A refused action is rolled back
  (rng, log, events), so it changes nothing even mid-turn. `illegal` = refused while nothing earlier
  in the same call had changed the state; after a change, `contested` (the tile or target is taken,
  the NPC is talking with someone else) or `stale`.
- `not ready` (and "only free actions" in `legalActions`) applies only to parties of two or more:
  a party of one always may act, as before (the world only hands control back once it can).
- Busy: `TurnInput.busy` without a successful turn action sets / clears `busySince`; a turn action
  deletes it. Nothing reads it yet (B2b).
- One dialogue per NPC is a refusal (`invalid` reason "… is talking with someone else"), not a
  `log.party.npc_busy` line: a refused action leaves no log. `log.party.talk_gone` (en + nb) is the
  only new key. Stale-choice checks (speaker dead, hostile, beyond `TALK_RANGE`, service or recruit
  taken) run only with two or more players, so a GM `trade` with a distant speaker closes at the end
  of the first round in a party.
- `enterArea` already carries the whole party (others on `nearestFreeFloor` from the start, before
  allies and spawns) and `doTransition` gives everyone `max(energy, ACT_COST)`: the immediate
  version of §5; B3 adds the countdown and the pending change.
- `checkEnd` still ends the run when any player is at 0 hp and not down (B2b brings `down`); win /
  lose conditions are evaluated for the lead.
- `Bot.decide` takes an optional `playerId`. `runParty` (no CLI yet) gives the lead runGame's memory
  seed, so a party of one plays runGame's game.
- Timing, 12 bots on fixture-western (areas up to 56×40, fast stepping): whole party turn incl. 12
  bot decisions mean 7–8 ms, p95 12–14 ms, max 25–54 ms; engine time ~1 ms per turn, of which FOV
  ~60 % (12 players × every call). Under budget, so no cross-call FOV cache yet; recheck at 91×65 in B3.

### B2b — AI among players, falling and revive, party goals

Scope: §3, §4. Sticky and busy targeting (`BUSY_MAX_TURNS`, close-in-to-2), per-player perception and
sneaking, symmetric `playerSeesTile(ctx, pid, pos)`, `who: 'player'` for AI conditions, GM "out of
view" for every player, allies follow / guard their owner; `killPlayer` → second chance / down
(idempotent), `resourceEmptied` through `killPlayer`, `partySecondChance`, `rules.ts` mercy estimate
per player, down players skip upkeep and energy, revive with fatal-resource refill, `checkEnd` all-down
loss, `evalParty` per-leaf quantification for win / lose / transition lock / quests, quest rewards;
`isAlive` audit; log keys `log.party.*` (en + nb catalogs); events `downed`, `revived`.
Files: `engine/ai.ts, combat.ts, turn.ts, effects.ts, conditions.ts, area.ts (lock only), gm.ts,
rules.ts, difficulty.ts, log-keys.ts, types.ts`, i18n catalogs.
New tests: `party-ai.test.ts` (nearest + sticky target, busy player not attacked but approached to 2,
busy expires after 10 turns, a turn action clears busy, splash still hits a busy neighbour, symmetric
perception per player, sneaking per player), `party-fall.test.ts` (second chance per player on
gentle/normal, none on hard (first fall = down), double hit in one turn, down skips regen / drain /
energy, revived by neighbour after 1 turn or alone after 20, fatal resource refilled on revive,
`emptyIsDeath` downs instead of losing, all down = lost, solo normal unchanged), `party-goals.test.ts`
(compound `all(has_item A, has_item B)` across two packs, `not`, `chance` drawn once, lose needs all,
down key-holder's pack counts).

### B3 — Area transitions and party scaling

Scope: §5, §6. Exit countdown (`partyRules.exitCountdownTurns`, default 5), decrement in `endRound`,
area change pending → `enterArea` from `runTurn` after `runWorld`, `area changed` refusals, early
entry when everyone is at the exit, everyone pulled along (down players up, resources refilled),
countdown survives its starter going down, placement and energy for everyone, allies per owner,
`on_area_enter` with the starter; `PARTY_SCALING`, `partyFactor` (skipped for n = 1); `MapGenerator`
4th argument and `makeContext` partySize; spawn counts, `scaledHostileHp` at every `maxHp` site
(spawn, transform, GM spawn, summons), `near_start` distance from players, item count, GM budget and
actor cap by party size; `area.partySize`.
Files: `engine/area.ts, actions.ts, turn.ts, party.ts, difficulty.ts, actors.ts, effects.ts (summons),
gm.ts, types.ts, mapgen/context.ts, mapgen/index.ts` (and generators only where they hard-code
dimensions), `log-keys.ts`, i18n catalogs.
New tests: `tests/engine/party-exit.test.ts` (countdown start, count down, early entry, pull-along with
a down player, starter downed mid-countdown, later inputs refused `area changed`, placement: all on
free reachable floor, lock checked against the party, solo transition immediate, custom
`exitCountdownTurns`), `tests/engine/party-scaling.test.ts` (n = 1 identical maps / spawns / hp to the
golden replay, growth for n = 2/4/12, caps, a unique's second phase keeps its scaled hp),
`tests/mapgen/party-size.test.ts` (every generator at party size 4; party size 12 on a subset of three
generators: valid, connected, start ≠ exit, dimensions as specified; one loose timing check at 91×65).

### B4 — Party sim tool, exit checks, tuning, docs

Scope: the rest of §8. `tools/sim.ts --party / --party-sizes / --timing` (with the injected clock),
summaries per party size with refusals by reason; bots made party-aware where runs show it is needed
(follow the party, revive a down teammate, gather at the exit); run the MP1 exit checks; tune
`PARTY_SCALING` from 2–4 player win rates; write `docs/progress/MP1.md` (checks, numbers, known
limits) and update the plan's status line.
Files: `engine/sim/party.ts, bots.ts, view.ts, run.ts, index.ts`, `tools/sim.ts`,
`src/engine/difficulty.ts` (constants), docs.
New tests: `tests/sim/party.test.ts` extended (4 players, bots never mutate the state, `onTurn` /
`now` hooks produce numbers), a short 12-player smoke (`tests/sim/party-12.test.ts`, capped turns).

## Review notes (2026-10-26)

Three reviews (rules, engine, risk). Accepted unless stated:

- Down players skip round upkeep; revive and pull-along refill fatal resources (rules 1, engine 5, risk 5): accepted, §4.
- Stale dialogues and double use of one NPC (rules 2, engine 6): accepted, §2.4.
- Busy as a free invulnerability toggle (rules 3, engine 7, risk 10): accepted; turn actions clear it, `BUSY_MAX_TURNS` caps it, hostiles stop at 2 tiles.
- Busy players as shields for AoE (rules 3): accepted the simpler rule; never chosen as target, splash still applies.
- "0 refused legal actions" fails on contested moves (rules 4): accepted; refusals by reason, the check counts only `illegal`.
- `rules.ts` mercy reads (rules 5): accepted, §1.3 and B2b.
- Solo Normal without a second chance (rules 6, engine 12, risk 9): kept as the design's reading so single player is unchanged; recorded as an open owner question in plan §6 rather than decided here.
- Fog size in snapshots (rules 7): accepted; `seen` stays per player (engine and bots read it), run-length coded in `serialize`, hashed as bytes.
- Countdown as a parameter, continues if its starter goes down (rules 8): accepted, in `GameState.partyRules` (not `EngineEnv`, so replays from the state agree).
- Wall clock in `src/engine/sim/party.ts` (rules 9): accepted; injected `now` / `profile` from `tools/sim.ts`.
- `color` in `PlayerState` (rules 10): accepted, dropped.
- Shared purse and shared XP beyond the plan (rules 11, engine 12): kept as design choices, recorded as open owner questions in plan §6; simultaneous-trades test added (B2a).
- Allies while the owner is down; down key-holder; `on_area_enter` user; mapgen timing (rules 12): accepted (guard the body; party packs count together; the starter; loose timing at 91×65).
- Actor-keyed code reads the acting player (engine 1, 2): accepted; the central change of §1.3 (`playerOf` vs `me`), moved into B0.
- Walking into a teammate (engine 3): accepted; swap places like allies.
- `enterArea` inside `endRound` (engine 4, risk 4): accepted; pending flag, `runTurn` enters after `runWorld`, later inputs refused.
- Whole-goal "any player" breaks compound goals (engine 8): accepted; per-leaf quantification, tree walked once.
- `who: 'player'` in AI and GM (engine 9): accepted; AI resolves to its target, GM stays on the lead in MP1 (documented).
- World never moves when all refused (engine 10): accepted; `advance` option, refused-only turns are not progress.
- `hostileHp` at every `maxHp` site, `near_start` crowding (engine 11): accepted.
- `obs.self`, `fast.ts` seen, XP of `grant_xp` (engine 12): accepted; `grant_xp` shared like kills.
- B0 before B1 and golden replay (risk 1, 2): accepted.
- No N > 1 `createGame` in B1 (risk 3): accepted; moved to B2a.
- Minimal `runParty` early and B2 split (risk 6, 7): accepted (B2a / B2b).
- Performance measured in B2 (risk 8): accepted; measured in B2a, cache across calls only if the numbers ask for it.
- Exit revive is cheap; Hard/Brutal first fall is a down (risk 9): kept (fast and fun; follows from "no second chance on Hard"); both recorded in plan §6.
- Hash canonicalisation and cost (risk 11): accepted, §7.
- Mapgen test time, placement order, guards for every player, skip scaling at n = 1 (risk 12): accepted.

Rejected: none outright. Two suggestions were narrowed: the countdown parameter lives in the state, not
`EngineEnv` (determinism), and the cross-call FOV cache is built only if B2a's timing shows FOV matters.
