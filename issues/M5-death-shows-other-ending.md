# Dying by HP showed the world's other lose ending (wrong end-screen story)

- Severity: major (M5 desktop playtest round 2; 6 of 20 demo worlds affected)
- Area: engine ending text (src/engine/ctx.ts), schema GoalSpec, end screen (src/client/view.ts)
- Status: fixed

## Evidence
Yams: jammed by a Process Server on turn 837, but the end screen showed the 1400-turn timeout text
"The contract lapses, the weather masts turn their backs…" (pt-desktop-r2-yams3-end.png). Same in
Sugar Hotel (thaw text after being cracked by a Gossip Moth; its loss is a fatal `snowpack`
resource), Long Drove (herd-breaks text after being brought down on leg 1) and Lowmoor (mum picks
you up early, i.e. the detentions loss, after losing to Guilt). `goal.lossText` was a single string
and both `endGame` (log) and `endView` (end screen) always used it, whatever ended the run.

## Fix
- Schema (backwards compatible): optional `goal.deathText` (max 500), the ending when the player is
  defeated (hp 0). `goal.lossText` stays the ending for goal.lose / a fatal resource, and is the
  fallback for defeat when deathText is absent (so every existing world behaves as before).
- Engine: `endingText(world, state)` (src/engine/ctx.ts, exported from src/engine) picks winText,
  deathText ?? lossText, or lossText by how the run ended: `state.endReasonKey` in the new
  `DEATH_REASON_KEYS` (end.loss.defeated/by/cause/by_cause/cause_typed/by_cause_typed) means defeat;
  `end.loss.resource` and the keyless goal.lose loss are condition losses. `endGame` logs it and
  `endView` shows it, so log and end screen always agree. Old saves without endReasonKey get lossText.
- `worldWarnings(world)` (src/schema/refs.ts): a soft warning when a world has goal.lose or an
  emptyIsDeath resource but no deathText (not a parseWorld error).
- Generation prompt: an "Endings" rule in src/llm/prompts/world.ts and schema notes for
  GoalSpec.lossText / GoalSpec.deathText in src/llm/prompts/world-schema.ts.
- Backfilled deathText in the 6 affected demo worlds: cyberpunk-rooftop-yams,
  abstract-yellow-triangle, alien-twilight-migration, detective-sugar-hotel, fixture-dream,
  fixture-teen.

## Regression tests
tests/engine/m5-endings-xp.test.ts "ending text by how the run was lost": the yams repro (moved
from tests/review/m5/pt-desktop-r2.test.ts) now shows deathText on screen and in the log; a
goal.lose loss shows lossText; defeat falls back to lossText without deathText; resource loss,
win and keyless old saves; DEATH_REASON_KEYS covers every loss key but the resource one;
worldWarnings; every demo world passes worldWarnings.
