# DESIGN — AnyWorld (working title)

> Status: **draft, being shaped interactively**. Sections marked *(proposed)* are defaults
> suggested by Claude and not yet confirmed. *Open questions* at the bottom.

## 1. Pitch

A turn-based roguelike where **no two runs are the same game, or even the same genre**. At
the start of each run an AI invents the world: genre, setting, tone, characters, items,
abilities, goal, and a few special rules. One run might be a dungeon crawl. The next might
be a frontier western, a generation-ship mystery, a week of teenage social survival, a
Viking feud or a noir investigation.
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

### 3.0 Genre freedom
- **The genre is chosen at the start of a run**, from the player's prompt or by the AI for
  *surprise me*. Fantasy dungeons are one option among many: westerns, sci-fi, school or
  teen drama, Vikings, detective/noir, historical, surreal, cozy, horror, and mash-ups.
- **Avoid clichés.** The generation prompt pushes for specific, surprising worlds: an
  unexpected angle on a genre, concrete details, a twist. It discourages generic tropes,
  like "an evil wizard in a dungeon".
  - *Surprise me* draws random seeds (genre × era × tone × twist) so the AI doesn't fall
    back on its favourites.
  - The game remembers recent worlds, locally, and asks for something different.
  - The *weirdness* slider sets how far it may stray from the familiar.
- **The engine is genre-neutral.** Its words are abstract: *areas* instead of dungeon
  levels, *actors* instead of monsters, and *conflict* instead of only combat. The AI
  supplies all of the flavour.
  - *Areas* can be caves, saloons and main streets, starship decks, school corridors,
    longships and fjords, rain-soaked city blocks, and so on.
  - **Map generators** to match: rooms and corridors, caves, open terrain with cover,
    town or street grids, buildings with floors, ships and stations. The AI picks one per
    area and sets its parameters.
  - The *descend* action becomes a themed *transition*: stairs, a train, an airlock, the
    next school day, a hidden door.
- **Conflict doesn't have to be violent.** A world can rename it and reskin it: HP could
  be "Composure" and attacks "Put-downs" in a teen drama, or "Nerve" and "Interrogations"
  in a detective story. Mechanically it's still the same tactical system. In addition,
  the engine offers *non-combat verbs* the AI can switch on per world:
  - **Talk / persuade:** stat checks or small exchanges driven by the GM
  - **Sneak:** noise and detection
  - **Search / investigate:** clues are items with a *Vague* or *Unknown* knowledge level
  - **Use on:** an item applied to a target
- **Win conditions** are just as varied: kill or defeat, reach, escape, collect, survive N
  turns, solve (combine clues), or protect.

### 3.1 Roguelike core
- **Turn-based roguelike:** grid-based, permadeath, procedurally generated areas,
  discovery-driven.
- **Turns** *(proposed)*: the player acts, then every creature acts by speed/energy, then
  timed effects tick.
- **Core loop:** explore a level → fight or avoid creatures → find items → use abilities →
  move on to the next area → the game master reacts to how the run is going.
- **Run length:** short, about 15 minutes. 3–5 levels plus a final objective the AI defined
  at the start (e.g. a boss, a relic, an escape or a ritual). The point is to taste many
  different worlds, not to master one. Save/resume is still supported.
- **Run start:** an optional text prompt from the player ("a drowned cathedral full of
  clockwork saints"), or blank for *surprise me*, plus sliders for difficulty and
  weirdness. The start screen also shows **inspiration prompts** from a curated library
  (see §9): a few random ones as clickable cards, plus a shuffle button. Picking one fills
  the text box so the player can tweak it. Prompts that have a recorded world can also be
  played instantly in demo mode. The AI generates the world from that while a loading screen shows its
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
    - **Equipped items stay in their slot** and are marked as equipped. At most one
      weapon, one armour and one trinket can be equipped at a time. Activating a weapon
      in the hotbar swaps to it.
    - **How using an item works.** Each item has a *use mode*, which the AI picks per item:
      - **Consumed:** used up on use (most potions and scrolls). Identical ones stack in
        one slot.
      - **Charges:** N uses, then the item is spent or becomes inert (wands, a lantern
        with oil). Things can refill the charges.
      - **Reusable:** never used up. Using it may cost MP or a custom resource, or have a
        cooldown in turns (spells, a whistle, a weapon's special move).
      - **Passive/equip:** does nothing when activated, but works while equipped or simply
        while carried (weapons, armour, charms).
    - Weapons and armour may have durability as a rule variant the AI chooses for a world,
      but not by default.
  - **Growth:** XP or a themed progression the AI defines (e.g. "absorb relics"). Each
    level-up offers 2–3 choices.
  - **NPCs and dialogue:** non-hostile characters voiced by the GM, who can offer trades,
    bargains and small quests. Any outcome is limited to GM actions from the whitelist.
  - **Item knowledge.** The engine always knows an item's exact effect. What the player
    sees depends on how well the item is known, which the AI sets per item:
    - **Clear:** the exact effect is shown ("Restores 20 HP").
    - **Vague:** you get a flavour description with no numbers ("Deals shadow damage",
      "Something stirs when you hold it"). The engine checks that the description is
      consistent with the real effect: the damage type and whether it helps or harms.
    - **Unknown:** you only see what it looks like ("a murky green flask"). It could be
      good or bad. Unknown item kinds get random themed appearances in each run, as in
      classic roguelikes.
    - **Learning:** using an item usually reveals it. It goes up one or more levels, and
      every copy of that item kind becomes known. Some items stay obscure even after use,
      because their effect is subtle, delayed or random. Other ways to learn: identify
      effects, NPCs, the GM, and possibly INT-based insight.
    - **What you know is part of the run.** The UI keeps your notes, e.g. "drank it, felt
      dizzy".
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
- About 8–15 *actors* (creatures, people, robots, rivals and so on): stats, behaviours,
  abilities, and a 3D model description
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
- **Two ways to deploy** a single game build, chosen by configuration. Both are always
  played in a web browser:
  - **Browser-only (static):** the game is a set of static files and can be hosted
    anywhere, including GitHub Pages. The browser calls the LLM directly: Anthropic with
    its direct-browser-access header, or an OpenAI-compatible endpoint that allows CORS,
    such as a local Ollama. The player enters an API key or endpoint in settings, and it
    is stored only in that browser's localStorage. Simple, but the key lives in the
    browser.
  - **Node backend:** a small server serves the game and proxies LLM calls. Keys live in
    the server's environment, and the browser never sees them. This is better for sharing
    with others.
- The provider code is shared. It runs in the browser for static mode and on the server
  for backend mode, behind the same `LLMProvider` interface. On the client, a
  `transport` choice (`direct` | `backend`) picks the mode.
- **Demo mode** works in both setups without any LLM: pick one of the recorded worlds.
  The GM uses canned and templated lines.
- Structured output is used wherever the provider supports it. Everything is validated
  against JSON schemas, and invalid output is retried with error feedback.

## 5. Presentation

- **Camera:** 3D tilted at about 45–55° from horizontal, like Diablo or Into the Breach in
  3D. Smooth follow, rotatable in 90° steps, zoomable.
- **Rendering:** Three.js. Tiles are low-poly blocks. Walls are cut away or turned
  transparent when they block the view of the player.
- **Model archetypes:** genres need people as much as monsters, so the AI starts most
  models from parameterised templates: humanoid (proportions, clothing, hats,
  accessories), quadruped, flier, blob, vehicle/robot, and prop. It only builds freeform
  compositions for truly odd things. This keeps cowboys and teenagers readable.
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

## 6. Controls

- Keyboard: arrow keys, WASD or vi-keys to move/attack, 1–8 for the quick-access slots, and single
  keys for inventory, pick-up, inspect, wait and descend.
- Mouse: click to travel or target, hover to inspect.

## 7. Tech

- **Playable in a web browser.** The two deployment modes are described in §4.4:
  static browser-only, or with a Node backend.
- TypeScript throughout. Vite for the client. The optional Node server (plain Node or
  Fastify) serves the client and proxies LLM calls.
- Engine core: pure TypeScript with no DOM, shared by the client, tests and simulation bots.
- Schemas: zod, also used to produce the JSON Schemas sent to the LLM.
- Tests: Vitest for the engine, bot playthroughs over many seeds and world specs, and
  Playwright for visual and end-to-end checks with screenshots.

## 8. Out of scope for v1

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
- **Prompt library:** while building, the agents write and try many player prompts across
  genres. The ones that work best go into `content/prompts.json`. A prompt works well
  when its world validates on the first try, passes the bot balance simulations and the
  screenshot review, and is clearly different from the others. Each entry has the
  prompt, its genre and tone tags, a one-line teaser, and a link to its recorded world
  if there is one. The game uses this library as inspiration on the start screen
  (§3.1). It also feeds into the *surprise me* seeds.
- **Recorded in the repo:**
  - `BUILD_LOG.md`: a chronological log of decisions, problems and resolutions
  - `STATS.md`: agents run, and time and tokens per phase (best effort)
  - `issues/`: bugs found by tests, reviews and playtests, with their fixes
  - `RETROSPECTIVE.md`: what worked, what didn't, and what a human still has to fix
- Git commit at every milestone.

## 10. Definition of done *(proposed)*

v1 is done when all of these hold. Each one is checked by automated tests or an agent playtest.

1. **Both deployment modes work.** `npm run dev` starts the backend mode, and
   `npm run build:static` produces a static site that runs browser-only. In both, a new
   run can be started with a prompt or with *surprise me*, or in demo mode with no LLM.
2. With the mock provider, at least **10 distinct recorded worlds** load, spanning at least 7 genres, of which
   at most 2 are fantasy or dungeon worlds, and at least 2 have mostly non-violent conflict. Each one
   validates against the schema and can be played start to finish in the browser.
3. **Bot simulation:** across those worlds and 100+ seeds, there are no crashes, no
   soft-locks (e.g. an unreachable exit), and runs both win and die at a reasonable rate.
4. **Every system works in play:** fog of war, combat, abilities and MP, inventory and
   equipment, levelling choices, item knowledge (clear/vague/unknown and learning), NPC dialogue, GM narration and events,
   rule variants, save/resume, and the win and death screens.
5. **Visuals:** the tilted 3D camera, AI-composed models for every creature and item,
   per-level lighting and fog, and wall cut-away. Playwright screenshots of every world
   are reviewed by an agent for readability.
6. **Graceful AI failure:** slow, invalid or missing provider responses never crash or
   freeze the game.
7. **Providers:** Anthropic and OpenAI-compatible providers implemented and covered by
   contract tests using mocked HTTP. One config switch selects the provider, and one selects the transport (direct or backend).
8. **Audio:** generative ambience driven by the world's mood. SoundCloud integration is
   optional and can be switched off (best effort).
9. **Prompt library:** at least 25 curated prompts covering at least 10 genres, shown on
   the start screen. At least 10 of them come with a recorded world that plays in demo
   mode.
10. A README covers setup, API keys and the firewall/allow-list note, plus the experiment
   documents from §9.

## 11. Open questions

- See the conversation. Answers get folded into the sections above.
