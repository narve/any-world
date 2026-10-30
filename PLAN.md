# PLAN — AnyWorld

How the design (`DESIGN.md`) gets built. This file is maintained by the orchestrator (Claude).

## Architecture

```
src/
  schema/      zod contracts: world.ts (World Spec), gm.ts (GM actions/responses), refs.ts (cross-ref validation)
  engine/      pure TS game rules — no DOM, no network, no Date/Math.random
    types.ts   runtime contract (GameState, PlayerAction, GameEvent, Rng…)
    index.ts   public API: createGame, step, applyGmActions, legalActions, describeItem/Actor, serialize
    rng.ts, fov.ts, path.ts, mapgen/, combat.ts, effects.ts, conditions.ts, triggers.ts,
    inventory.ts, knowledge.ts, progression.ts, ai.ts (monster behaviour), npc.ts, gm.ts (apply GM actions),
    balance/ (power budgets, auto-rebalance), sim/ (bots)
  llm/         provider layer, shared by browser + server
    types.ts, presets.ts, anthropic.ts, openai-compatible.ts, mock.ts, structured.ts (validate/repair/retry),
    transport.ts (direct | backend), prompts/ (world, gm, dialogue), generate.ts (world pipeline), gm-runtime.ts
  client/      browser app (Vite root)
    index.html, main.ts, game-controller.ts (engine <-> renderer <-> UI <-> GM),
    render/ (three.js scene, camera, tiles, models/archetypes, lighting, cutaway, vfx, animation)
    ui/ (HUD, log, hotbar, backpack, inspect, dialogue, level-up, start screen, settings, loading, end screens)
    audio/ (generative ambience, sfx, soundcloud), storage.ts (saves, settings, recent worlds)
  shared/      tiny helpers usable everywhere
server/        Node backend: serves dist/client, POST /api/llm proxy (keys from env), /api/presets
content/
  worlds/      recorded World Specs (fixtures + demo worlds) *.json
  prompts.json curated inspiration prompts
  recordings/  recorded LLM responses for the mock provider
tools/         CLI: sim.ts (bot runs), validate-worlds.ts, screenshot.ts, agent-provider helpers
tests/         vitest (engine, schema, llm contract tests, sim smoke)
e2e/           playwright (headed chromium under xvfb — WebGL needs it here)
docs/progress/ milestone screenshots and notes
issues/        one markdown file per bug found (status: open/fixed)
```

Key rules for every contributor (agent):
- **The engine is deterministic and pure.** `step()` clones then mutates the clone; it never touches its input.
- **Contracts first.** `src/schema/*` and `src/engine/types.ts` are shared contracts. Change them only when
  necessary, keep the changes backwards compatible, and note each change in `BUILD_LOG.md`.
- **Genre-neutral code.** Never hard-code words like "monster" or "dungeon" in UI strings. Use the
  world's `vocabulary`.
- **Every module comes with tests.** Run `npm run typecheck && npm test` before calling a task done.
- Log notable decisions and problems in `BUILD_LOG.md`, one dated line each, prefixed with the
  milestone/agent tag.

## Milestones

| # | Milestone | Content | Exit check |
|---|---|---|---|
| M0 | Contracts | scaffold, schemas, engine types, LLM types, PLAN | typecheck ✓ |
| M1 | Foundation | fixture worlds + ref validator; engine core (turns, move, combat, effects, FOV); mapgen (all generators); renderer base (camera, tiles, archetype models, lighting, cutaway); LLM providers + presets + server proxy; UI shell; integrate into playable loop | play a fixture world in the browser; tests green; screenshots |
| M2 | Systems | inventory/equip/use modes, knowledge, progression/perks, statuses/triggers/rule variants/resources, NPCs + talk/persuade/search/sneak, quests, GM action application + budget, win/lose, save/resume; renderer: animations, vfx, damage numbers; full UI | every DoD §4 system playable on fixtures; bots don't crash |
| M3 | AI content | prompts (world/GM/dialogue), generation pipeline with validate/repair/retry + balance check + rebalance, GM runtime (async hooks, fallbacks), agents-as-provider: ≥25 prompts → worlds → validated → simulated → screenshot-reviewed → curated | ≥10 demo worlds over ≥7 genres; prompts.json ≥25 |
| M4 | Polish & modes | audio (generative + SoundCloud optional), static build + direct transport, demo mode, settings UI, start screen with inspiration, README | `build:static` works; both modes e2e |
| M5 | Verify | full DoD sweep: bot sims 100+ seeds/world, e2e playthroughs, screenshot review, adversarial code review, fix loops until green; retrospective | DoD all ✓ |

Each milestone runs as one or more **workflows**: parallel builders, each owning its own directories,
then integration, then review/verification agents, then fix loops. After each milestone the
orchestrator commits, writes a ping in `docs/progress/Mx.md` with screenshots, and updates `STATS.md`.

## Testing strategy

- **Unit tests:** schema, effects, conditions, combat math, inventory rules, knowledge transitions,
  mapgen invariants (connectivity, start/exit reachable).
- **Simulation:** `npm run sim -- --world <file> --seeds 100` runs bots (greedy explorer, cautious,
  random) and reports wins, deaths, soft-locks, crashes and average turns.
- **LLM contract tests:** mocked `fetch`, one per provider preset family.
- **E2E:** Playwright drives the real client in demo mode, captures screenshots, and checks for
  console errors.
- **Agent review:** reviewers look at screenshots for readability, and adversarial code reviewers try
  to find bugs. Every confirmed bug is recorded in `issues/`.

## Risks

- WebGL in headless test runs only works in headed Chromium under xvfb (already verified).
- The World Spec JSON Schema is large (~110k characters), so the prompts use a condensed TypeScript-style
  schema description, and validation uses zod.
- No live LLM is available during the build, so the prompts are tuned with agents acting as the provider.

## Backlog added during M1 (scheduled for M2)

- **Non-Earth-like worlds** (user, during M1): add `islands` (floating platforms over a void),
  `organic` (membranes/blobs), `geometric` (abstract patterns/symmetries) generators; abstract
  surface patterns (`gradient`, `grid`, `noise`, `lines`, `none`); `AreaPlan.backdrop` (void/sky
  style: starfield, gradient, clouds, abyss, colour). The renderer and engine must not assume
  realism. The world-generation prompt should explicitly invite non-realistic worlds.
- **GM-invented rules** (user, during M1): add GM actions `add_rule {rule: RuleVariant, reason}` /
  `remove_rule {id}`. Engine keeps `state.activeRules` (world rules + GM rules, max 5), at most one
  new GM rule per area, power-impact estimate vs difficulty (refuse/require counterweight). Add a UI
  "Rules" panel. The GM prompt gets the active rules and difficulty.
- **Clearer controls & goals** (user playtest of M1, Lowmoor): pressing a hotbar key on an already-equipped
  passive item (starting Thesaurus, "E" badge) opens the backpack inspect view — by design, but it reads as a
  bug. Fix: equipped item → small inline tooltip/toast ("Equipped as your Comeback — bump into rivals to use
  it"), never a surprise backpack; explain the E badge. Add an always-visible **goal tracker** (world goal
  summary + current step/quest, e.g. "Get your speech notebook back from Rosalind"), contextual key hints
  (near NPC: "T talk", on item: "G pick up", at exit: "> Walk home…", locked exit: why), and a short
  first-run onboarding card per world (how to win, how conflict works here). High priority, first in M3.

## Backlog added during M2 (user)

- **Languages (requirement, at least Norwegian):** see DESIGN §7b and DoD #11. This is scheduled in the
  chained M3–M5 workflow. M3 adds `WorldMeta.language` and makes the world/GM/dialogue prompts
  language-aware, and the agents-as-provider produce at least 2 Norwegian demo worlds. M4 adds the UI
  message catalog (en + nb), a language picker, engine log events as key + params instead of English
  sentences, a missing-key test, and translated prompt-library entries.
- **Future, not v1:** sharing generated worlds and multiplayer (DESIGN §12). v1 only keeps the door open:
  versioned specs that can be exported and imported, and no unnecessary single-player assumptions.
- **Mobile & responsive (requirement):** see DESIGN §6b and DoD #12. This is scheduled in the chained
  workflow. M3 starts with the controls & goals work, which is designed touch-first (context buttons
  double as the key hints). M4 adds the responsive layout and bottom sheets, touch input, the mobile
  render quality tier and performance budget, and Playwright device projects (iPhone and Pixel,
  portrait and landscape). M5 runs a touch-only playthrough with bots driving tap input.
- **Priority note (user, during M3):** fun and fluent gameplay matters more than exact balance or fairness
  (DESIGN §2.5). Reviewers and fixers should treat balance bands as guard rails, report flow/fun problems
  (friction, waiting, confusing moments, dead ends, boring stretches) as major issues, and not burn
  rounds fine-tuning win rates. For future multiplayer, avoid waiting; occasionally missed turns are OK.

## Backlog added after MP5 (user, 2026-10-30)

- **TODO: sound on/off button.** Today sound is muted only from the settings dialog (`muted` in
  `applySettings`, src/client/audio-bridge.ts). Add a one-tap speaker toggle that is always visible
  during a run (desktop HUD and phone layout). It uses the same stored `muted` setting, so the toggle
  and the settings dialog never disagree. Keyboard shortcut (e.g. `M`) if it doesn't clash. en + nb strings.
- **TODO: clean up the front page.** The start screen (src/client/ui/components/screens.ts) has grown
  with each milestone: provider note, demo worlds, own worlds, party option, open rooms. Tidy it up,
  with a clear main action, less text, related things grouped and secondary options folded away. Check
  it on phone portrait as well as desktop.
- **TODO (bug): switching off music in settings isn't saved.** The music comes back on the next
  load or run. Likely cause, not yet verified: the music panel's Mute button
  (src/client/audio/music-panel.ts) calls `engine.mute()` directly and never updates the stored `muted`
  setting (`saveSettings`, src/client/storage.ts). Make every mute/volume control write the setting,
  add a regression test (mute, reload, still muted), and share the code path with the sound on/off button.
