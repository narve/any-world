# DESIGN — AI-Defined Roguelike (working title)

> Status: **draft, being shaped interactively**. Sections marked *(proposed)* are defaults
> suggested by Claude and not yet confirmed. *Open questions* at the bottom.

## 1. Pitch

A turn-based roguelike where **no two runs are the same game**. At the start of each run an
AI invents the world: setting, tone, creatures, items, abilities, goal, and a few special rules.
During play the same AI acts as a **live game master**: it narrates, voices characters and
introduces events. The engine guarantees the game stays playable and fair.

## 2. Core principles

1. **The AI composes, the engine enforces.** The AI never writes code. It writes structured
   data (JSON) that combines a large set of mechanical building blocks the engine provides.
   Everything it produces is validated, and anything invalid is repaired or rejected.
2. **Never wait on the AI during normal turns.** Moving, attacking and using items are fully
   local and instant. AI work happens at the start of a run, at level transitions, and at
   game-master moments, ideally in the background.
3. **Deterministic core.** The game state is pure data, and the rules are a pure function
   `(state, action, rng) → state`. That allows replays, save files, automated tests and
   simulated playthroughs by bots.
4. **Graphics serve readability.** The aim is a good-looking low-poly 3D world, but you should
   always be able to tell what is on screen and what will happen.

## 3. Genre and gameplay

- **Turn-based roguelike:** grid-based, permadeath, procedurally generated levels,
  discovery-driven.
- **Turns** *(proposed)*: the player acts, then every creature acts by speed/energy, then
  timed effects tick.
- **Core loop:** explore a level → fight or avoid creatures → find items → use abilities →
  descend → the game master reacts to how the run is going.
- **Run length:** short, about 15 minutes. 3–5 levels plus a final objective the AI defined
  at the start (e.g. a boss, a relic, an escape or a ritual). The point is to taste many
  different worlds, not to master one. Save/resume is still supported.
- **Run start:** an optional text prompt from the player ("a drowned cathedral full of
  clockwork saints"), or blank for *surprise me*, plus sliders for difficulty and
  weirdness. The AI generates the world from that while a loading screen shows its
  progress (e.g. the world name and tagline as soon as they exist).
- **Difficulty — fair but deadly:** real permadeath. Before play starts, the engine checks
  the AI's content against power budgets and runs quick bot simulations of the generated
  world. Worlds that are unwinnable or trivial get rebalanced automatically, or sent back
  to the AI with feedback.
- **Character systems (v1):**
  - **Inventory and equipment:**
    - **Slots are generic.** No slot is reserved for a kind of thing: potions, weapons,
      armour, scrolls, spells, tools and quest items can go in any slot. Spells and
      abilities are slot items too, so learning a spell puts it in a slot.
    - **8 quick-access slots** (hotbar, keys 1–8). What activating a slot does depends on
      the item: drink a potion, cast a spell, throw a dagger, or equip/swap a weapon.
    - **20-slot backpack** for everything else. Opening it is free; using or moving items
      costs a turn.
    - **Equipped gear** (weapon, armour, trinket) is a separate state. You equip an item
      from any slot, and it gives no extra storage.
    - Identical consumables stack.
  - **Growth:** XP or a themed progression the AI defines (e.g. "absorb relics"). Each
    level-up offers 2–3 choices.
  - **NPCs and dialogue:** non-hostile characters voiced by the GM, who can offer trades,
    bargains and small quests. Any outcome is limited to GM actions from the whitelist.
  - **Identification:** unidentified item classes (e.g. potions or scrolls) get randomized
    themed appearances. You learn what they do by using them, through other items, or
    from NPCs.
- **Fog of war and field of view:** you only see what your character can see, and the map
  remembers what you have explored.

## 3a. Character stats — familiar, few, flexible

**Flexibility** is the main concept. The stats are a small, familiar RPG set, and each world
reshapes them. The goal is to avoid making the game too geeky.

| Stat | Role |
|---|---|
| **Strength (STR)** | Melee damage and carry/equip requirements |
| **Dexterity (DEX)** | To-hit, evasion, ranged attacks |
| **Intelligence (INT)** | Ability power and mana pool |
| **Health (HP)** | Hit points; you die at 0 |
| **Mana (MP)** | Resource spent on abilities, regenerates slowly |
| **Armour (AC)** | Base armour class: reduces/avoids incoming damage |

- Speed and sight radius exist, but are mostly invisible: they're shown as "fast" or
  "slow" and changed by effects, not raised directly by the player.
- Per world, the AI may: rename/reflavour stats (Mana → "Faith", STR → "Grit"), set
  starting values and growth, change what MP is called and how it regenerates, and add
  **at most 2 custom resources**.
- Creatures use the same model in simplified form.
- The UI shows at most about 8 numbers at once.

## 4. The AI's roles

### 4.1 World generation (at the start of a run)
The AI produces a **World Spec** containing:
- Setting, tone, palette, lighting/fog style, and the name of the world
- The player character (or a choice of a few), with starting stats, abilities and items
- A bestiary of about 8–15 creatures: stats, behaviours, abilities, and a 3D model description
- About 15–25 items, plus abilities, status effects and terrain features
- A level plan describing each depth's theme, which creatures and items appear there, and
  special features
- The win condition and 1–3 **rule variants**, such as "light is a resource that runs
  out", "killing spreads corruption" or "every potion is unidentified"

### 4.2 Rule variants: the building blocks
The engine offers a vocabulary the AI combines. Examples:
- **Stats:** see §3a. The AI can rename and reflavour them, and decide which ones matter
  most in its world. It can also add up to 2 custom resources (e.g. "Sanity", "Oil").
- **Effects:** damage (typed), heal, apply/remove status, teleport, push/pull, summon, spawn
  terrain, change a resource, reveal map, transform, and so on
- **Triggers:** on hit, on kill, on turn, on enter tile, on pick-up, on resource threshold,
  on death, on level enter, and so on
- **Targeting:** self, adjacent, ray, cone, area, all visible
- **Behaviours:** melee chaser, ranged kiter, coward, pack hunter, ambusher, wanderer,
  guardian, and so on, with parameters
- **Conditions:** used for win, lose, and when a trigger fires

### 4.3 Live game master (during play)
- **Presence: moderate.** It narrates arrivals on a new level and key discoveries, runs
  NPC conversations, and fires about one event per level. You notice it, but it isn't
  constant.
- **When it acts:** entering a new level, discovering notable rooms, talking to NPCs, major
  events (boss, near-death, milestones), and occasionally on a timer measured in turns.
- **What it can do:** narrate text, speak NPC dialogue, choose among player options (e.g.
  bargains), and issue **GM actions** taken from a whitelist using the same building blocks:
  spawn, gift, curse, change terrain, start an event or quest. Budgets keep it balanced.
- **Asynchronous:** requests are prepared ahead of time where possible. When the AI is slow
  or offline, the game continues with fallback text or simply without the event.
- **Context:** the GM gets a compact summary of the world, the run so far and the current
  situation, kept within a token budget.

### 4.4 Providers
- A pluggable `LLMProvider` interface: Anthropic Claude by default, OpenAI-compatible APIs
  (which covers Ollama and other local models), and a **mock provider** that replays
  recorded responses for tests and for offline play.
- A small local Node server holds the API keys and talks to the providers. The browser
  never sees the keys.
- Structured output is used wherever the provider supports it. Everything is validated
  against JSON schemas, and invalid output is retried with error feedback.

## 5. Presentation

- **Camera:** 3D tilted at about 45–55° from horizontal, like Diablo or Into the Breach in
  3D. Smooth follow, rotatable in 90° steps, zoomable.
- **Rendering:** Three.js. Tiles are low-poly blocks. Walls are cut away or turned
  transparent when they block the view of the player.
- **AI-composed models:** each creature and item is described as a small tree of primitives
  (box, sphere, cylinder, cone, capsule, torus) with transforms, colours, emissive/material
  hints, and simple procedural animation (bob, sway, pulse, spin). The engine renders them,
  and the result is checked for things like size and colour contrast.
- **Lighting:** per-level ambient light, fog, and light sources the AI defines. Torches and
  glows are a big part of the atmosphere.
- **UI:** HTML overlay with a message log, GM narration panel, stats and resources,
  inventory, ability bar, and inspect/tooltip.
- **Feedback:** short tweened animations for moves, attacks, damage numbers and effects.
  They never block input for long, and you can skip them.

## 5b. Audio (nice to have, not required)

- The World Spec includes an **audio mood**: genre, tempo, instruments, and keywords for
  each level and situation (explore/combat/boss).
- **Music sources**, as optional pluggable modules:
  1. **SoundCloud:** after creating the world, the AI picks search terms and the game finds
     suitable (preferably Creative Commons) tracks or a playlist to play through the
     embedded SoundCloud widget. Risk: SoundCloud's API needs registered app credentials,
     which are not always granted. Fallback: the AI suggests a playlist or search query and
     shows it as links.
  2. **Generative ambience** *(proposed fallback)*: a small WebAudio synth (drones, pads,
     noise, pulses) driven by the AI's mood parameters. Works offline and always fits the
     theme.
- Simple procedural sound effects (hit, step, pick-up) if time permits.
- The game must be fully playable with audio off.

## 6. Controls *(proposed)*

- Keyboard: arrow keys, WASD or vi-keys to move/attack, 1–8 for the quick-access slots, and single
  keys for inventory, pick-up, inspect, wait and descend.
- Mouse: click to travel or target, hover to inspect.

## 7. Tech *(proposed)*

- TypeScript throughout, Vite for the client, and a Node server for the AI proxy.
- Engine core: pure TypeScript with no DOM, shared by the client, tests and simulation bots.
- Schemas: zod, also used to produce the JSON Schemas sent to the LLM.
- Tests: Vitest for the engine, bot playthroughs over many seeds and world specs, and
  Playwright for visual and end-to-end checks with screenshots.

## 8. Out of scope for v1 *(proposed)*

Multiplayer, mobile/touch, progression between runs, and
AI-generated images/textures.

## 9. Development process (the AI-driven experiment)

- **Fully autonomous build** by Claude with multiple agents, after the design and plan are
  agreed. Bypass-permissions mode is used in the sandbox.
- **Check-ins:** a short status ping with screenshots at each milestone. The build keeps
  going without waiting for replies.
- **No live LLM during the build:** the real providers are implemented, but tests use the
  mock provider. To reduce the risk that the real prompts are untested, **agents act as
  the provider**: a subagent gets the exact system prompt and schema the game would send
  and produces the response. Those responses are validated, recorded as fixtures, and used
  to tune the prompts. You do the first live run against a real API.
- **Recorded in the repo:**
  - `BUILD_LOG.md`: a chronological log of decisions, problems and resolutions
  - `STATS.md`: agents run, and time and tokens per phase (best effort)
  - `issues/`: bugs found by tests, reviews and playtests, with their fixes
  - `RETROSPECTIVE.md`: what worked, what didn't, and what a human still has to fix
- Git commit at every milestone.

## 10. Definition of done *(proposed)*

v1 is done when all of these hold. Each one is checked by automated tests or an agent playtest.

1. `npm install && npm run dev` starts the server and client. A new run can be started
   with a prompt or with *surprise me*.
2. With the mock provider, at least **10 distinct recorded worlds** load. Each one
   validates against the schema and can be played start to finish in the browser.
3. **Bot simulation:** across those worlds and 100+ seeds, there are no crashes, no
   soft-locks (e.g. an unreachable exit), and runs both win and die at a reasonable rate.
4. **Every system works in play:** fog of war, combat, abilities and MP, inventory and
   equipment, levelling choices, identification, NPC dialogue, GM narration and events,
   rule variants, save/resume, and the win and death screens.
5. **Visuals:** the tilted 3D camera, AI-composed models for every creature and item,
   per-level lighting and fog, and wall cut-away. Playwright screenshots of every world
   are reviewed by an agent for readability.
6. **Graceful AI failure:** slow, invalid or missing provider responses never crash or
   freeze the game.
7. **Providers:** Anthropic and OpenAI-compatible providers implemented and covered by
   contract tests using mocked HTTP. One config switch selects the provider.
8. **Audio:** generative ambience driven by the world's mood. SoundCloud integration is
   optional and can be switched off (best effort).
9. A README covers setup, API keys and the firewall/allow-list note, plus the experiment
   documents from §9.

## 11. Open questions

- See the conversation. Answers get folded into the sections above.
