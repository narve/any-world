# Retrospective

> Drafted by agents during M5 (review round 1 and the gate) and finalized by the orchestrator on
> 2026-10-25 after re-running the checks. Full token figures are in [STATS.md](STATS.md).

AnyWorld was built by Claude agents working on their own in a sandbox (DESIGN §9). A human agreed the
design, answered a few questions mid-build and changed some requirements (non-Earth worlds, GM-invented
rules, languages, mobile, fun over exact balance). No live LLM was called during the build. This file
says what worked, what did not, and what a human still has to check. The final check of every
Definition-of-Done item is in [docs/progress/M5.md](docs/progress/M5.md).

## The build in numbers

| Milestone | Agents | Wall time | Tests at the gate |
|---|---|---|---|
| M0 contracts | orchestrator only | ~1h | contracts typecheck |
| M1 foundation | 27 (3 lost to API 529) | ~2h43m | 545 vitest, 25 Playwright |
| M2 systems | 30 | ~4h08m | 909 vitest, 86 Playwright, sim 1600 runs |
| M3 AI content | 21 | ~3h34m | vitest green, 121 Playwright, 18 worlds valid, sim 3600 runs |
| M4 polish & modes | 5 | ~6h27m (3h20m of it a stalled agent) | 1448 vitest, 140 Playwright, nb playthrough 3/3 |
| M5 review & fix | 6 reviewers × 3 rounds, ~9 fixers per round, 1 gate | ~10h (22:23 → ~08:40 UTC) | 1810 vitest (145 files), 182 Playwright + 13 final-screenshot tests, sim 4000 runs + new-player gate 20/20 |

There are 20 recorded worlds in 18 genres, 5 of them in Norwegian bokmål, and 12 non-violent. One is
fantasy. The prompt library has 38 prompts. Agent transcripts, token counts and tool calls are in
[STATS.md](STATS.md). Every bug that was found has a file in [issues/](issues/).

## What worked

- **Contracts first (M0).** The zod World Spec, the engine types and the client view model were agreed
  before any builder started. Parallel agents each owned their own files and met at those types. Most
  integration problems were wiring that was missing, not types that disagreed.
- **A pure, deterministic engine.** Seeded runs made every bug report replayable. A bot can play
  thousands of runs in a minute, and the review in M5 could fuzz engine purity over all 20 worlds.
- **Bots as balance testers.** `npm run sim` (explorer, cautious, talker, random) found soft-locks, stuck
  loops and runs that were too easy or too hard long before a human played. The talker bot found the
  "persuaded the boss but never got the ring" soft-lock in Every Clause Binds.
- **Agents acting as the LLM provider.** World authors got the exact prompt the game sends, and their
  replies went through the same validation, repair and balance code as live replies. That gave 14
  playable, recorded worlds and concrete prompt fixes: 7 of 14 worlds were valid on the first try, and
  6 of the 7 failures were length limits. The limits were then put in one list in the prompt.
- **Review, playtest and fix rounds.** Adversarial reviewers wrote failing tests first, and fixers made
  them pass. Desktop, mobile and Norwegian playtesters played in a real headed browser and looked at
  their own screenshots. This found the problems that unit tests cannot see: buttons off screen in phone
  landscape, the inverted zoom keys, English text in the bokmål UI, and a recorded world labelled
  "made by AI".
- **Headed Chromium under xvfb.** Headless Chromium had no WebGL in the sandbox. Under xvfb, every e2e
  test ran the real three.js renderer.
- **Lazy loading.** Each world spec and three.js are their own chunks. The first load went from 1.78 MB to
  0.82 MB (268 kB gzip).

## What did not work (or cost time)

- **Agents misreading the conversation.** In M2, two agents treated the orchestrator's status question
  ("how is the workflow going?") as their task and declined to build. From M3 on, every task states its
  authorization and says to ignore chat from elsewhere.
- **Infrastructure stalls.** The M1 integrator died on an API 529 and the review loop had to do the
  integration. The M4 gate agent sat idle for 3h20m after a response was cut off mid-stream. Workflow
  scripts should retry critical agents and should time out silent ones.
- **Shared dev servers and HMR.** Agents editing files in parallel reloaded other agents' pages through
  Vite HMR, which made e2e runs flaky. The fix was a port per role and an HMR stub in the specs.
  Screenshot specs also overwrote committed milestone screenshots on every rerun until they were moved
  behind `SHOTS_TO_DOCS`.
- **Timing tests under load.** The mapgen timing assertions fail when the sim or Playwright runs at the
  same time. They pass when run alone.
- **Ownership gaps.** A fix sometimes needed one line in a file another agent owned, such as wiring a new
  catalog key, a view-model field or a boot hook. Those lines waited for a gate agent, or were written
  as small contract additions and reported. Some features were built but not mounted until the gate (the
  music panel, the engine-text catalog keys).
- **Late requirements.** Languages and mobile were added while M2 ran. They fit in because the design had
  room (i18n keys on log lines, one view model), but they made M4 the longest milestone.
- **Bot blind spots.** Bots hoard consumables they do not understand (lecture notes in Gullkalven) and
  circle kiters. Their win rates are a guide to balance, not the truth about it.
- **Experiment documents were left behind.** Until M5 there were no M3/M4 rows in STATS.md and almost no
  M3/M4 issue files, although BUILD_LOG.md had the material. The issues were back-filled in M5. Recording
  each fix as an issue file at the time is cheaper.

## M5: what three review rounds found

Each round found fewer and narrower problems, but never zero:

- **Round 1** (the largest batch of the 80 M5 issue files): mostly UX and wording. Inverted zoom keys, buttons out of reach in phone
  landscape, the inspect card that would not close, a second run that skipped the prologue, English in the
  bokmål UI, trade names cut off, new players dying in the first area.
- **Round 2** (fewer, deeper): The GM could win the run for the player through side doors (a goal flag, a
  damage effect without bounds, a free trade); stored worlds evicted the saved run; API keys leaked
  between presets; XP grants overflowed the stack; deep-nested imports crashed the parser.
- **Round 3** (11 items for the gate): the last side doors of the GM (a copy of the boss, a standing rule that strikes foes,
  a check made against the state at request time and applied later), and play-feel issues (keys pressed
  for combat picking a perk, a "reaches 5 tiles" claim that did not match the range check, a win route
  the goal tracker never showed).

The adversarial code reviewer was the most productive role per token: it wrote a failing repro test for
every claim, so a fix could be checked by a test that failed first and passed after. The GM fiat checks
alone took three rounds. Every fix closed the door it was shown and nothing else; only the gate's
defence-in-depth changes in the engine (no defeat credit for allies, no GM rules aimed at foes) closed the
class of problem.

## Honest quality assessment

- **Engine and content: solid.** Pure, deterministic, fuzzed for purity, 0 crashes in thousands of bot
  runs per round, 20 worlds that validate and play to an end screen in the browser. The worlds are varied and
  often funny (a nitrogen-fixing bacterium passing plant customs, a Norwegian troll bureaucracy).
- **AI pipeline: well tested, never run live.** Generation, repair, balance and the GM are covered by
  contract tests and by agents acting as the model. Real latency, cost, failure modes and tone are unknown.
- **The GM is the riskiest part.** Its checks grew from a short list into many special cases, each found by a
  reviewer. A real model will find new ways to be too kind or too cruel. The engine-side limits added at the
  gate (allies give no defeat credit, GM rules may not strike foes, statuses capped, actor cap per area)
  are the right kind of defence and should be extended rather than adding more case checks.
- **Difficulty: still too hard for beginners.** The bots pass the gate, but the desktop new-player
  playtester won 1 of 10 runs on Gentle in round 3, and the touch-only phone runs lost 8 of 8 over rounds 2–3.
  "Fun over exact balance" was the brief; deaths still dominate the first hour.
- **UI: clear but busy.** HUD, goal card, rules pills, log and hotbar fit at every tested size and language
  (screenshots in docs/progress/M5). The goal card now explains the next step. A human should judge whether
  it is pleasant, not only readable.
- **Mobile and audio: emulated only.** Touch, frame rate, safe areas, iOS audio unlock and the music itself
  have never met a real device or a human ear.

## Lessons for AI-driven development

1. **Make claims testable and make the reviewer write the test.** "Failing repro first" turned vague review
   comments into work a fixer could finish and a gate could verify.
2. **Fix classes, not instances.** When the same component is breached three rounds in a row, stop
   patching cases and add an invariant at the lowest layer (the engine), with a property test.
3. **Agents report honestly but optimistically.** Status lines like "fixed (client side); the engine half is
   left to its owner" were common. A gate that re-reads every issue status and runs every repro is
   essential; the ownership split leaves halves behind.
4. **Environment state is shared state.** Stale dev servers from earlier agents caused this gate's first
   e2e failures (port 5173 without its API server). Workflows should start and stop their own servers
   and check ports before e2e.
5. **Bots are cheap players, not players.** They found every soft-lock and crash, but not that the game
   feels too hard. Human-like playtest agents (screenshots, a goal, no engine access) found that.
6. **Screenshots need a budget.** Three review rounds left ~1180 screenshots (~410 MB) in docs/progress/M5.
   Keep review screenshots in test-results and promote a few to docs.

## What a human still has to check

These could only be tested in emulation, or with recorded and agent-written replies:

1. **The first live LLM run.** Create a world with a real key in both modes (`npm run dev` with
   `ANTHROPIC_API_KEY` and so on, and the static build with a browser key). Check generation time, how often
   the repair and balance turns are needed, the GM's tone and help ceiling, and token cost. Try a
   Norwegian prompt as well.
2. **Real-device touch.** Play a full run on a real iPhone and a high-end Android phone: tap, long-press,
   pinch and twist, bottom sheets, and the context bar in both orientations.
3. **Frame rate on phones.** The quality tiers and draw-call budgets were measured in emulated Chromium
   with SwiftShader. Check that 'auto' drops to 'low' on a real phone and that the game stays fluid.
4. **iOS audio unlock and safe areas.** Check that sound starts after the first tap on iOS Safari, that
   the mute toggle holds, and that the HUD clears the notch and home indicator (`viewport-fit=cover` and
   `env(safe-area-inset-*)`).
5. **WebGL context loss on a real device**, for example after switching apps on a phone.
6. **SoundCloud.** Embedding needs a direct track or playlist link and network access to SoundCloud.
7. **Norwegian with a native reader.** Agents reviewed the bokmål, but world words are put into templates
   without inflection, so some sentences will read stiffly.
8. **Deployment.** `npm start` behind a real reverse proxy (`TRUST_PROXY`, rate limits), and the static
   build on a real host such as GitHub Pages in a sub-folder.

## The orchestrator's own mistakes

The orchestrator (the main Claude session that talked to the owner and launched the workflows) also slipped:

- **Reverting a shared file during a run.** While committing a design change, it ran `git checkout BUILD_LOG.md`
  and threw away entries that running reviewers and fixers had appended. It recovered 17 entries from the
  agent transcripts. The rule: never check out, restore or stash a file a running workflow writes; stage only
  the paths you changed.
- **Slow to notice stalls.** The M2 refusals and the 3h20m M4 gate stall were both found only when the owner
  asked for status. The orchestrator should check workflow journals on a timer rather than waiting for a
  completion notice.
- **Screenshot growth went unchecked.** About 1600 review screenshots (~575 MB for M3–M5) were committed into
  git before anyone looked at the size. A size check belongs in each gate.

## If we did it again

- Put retries and an idle timeout on every agent in the workflow script from the start.
- Give each role its own dev-server port and an HMR-free config on day one.
- Have screenshot specs write to `test-results/` from the first spec.
- Write the issue file in the same change as the fix, and add the STATS row when the gate closes.
- Add the language and mobile requirements to the design before M1. Retrofitting catalog keys and
  touch input later cost two milestones of wiring.
