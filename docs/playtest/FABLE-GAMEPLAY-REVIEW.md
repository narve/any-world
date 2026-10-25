# AnyWorld single-player gameplay review (Fable playtest, October 2026)

Playtester: Claude (Fable 5.1), playing as a new human would: a headed Chromium under xvfb driven with
real keyboard, mouse and touch input, reading the screen after each action. Recorded demo worlds, no AI
key (recorded GM lines). Five complete runs across five worlds, two difficulties, desktop and phone.
Screenshots referenced below are in `docs/playtest/fable/`; the full set (150+) is under
`test-results/fable-playtest/` (git-ignored). No game code, content or tests were changed.

## 1. Summary

**Verdict: beautiful, unusually clear at the edges, slow and dicey in the middle.** The first minute of
every run is excellent: a prologue card, a per-world "how to play" card that explains the conflict verb
("Innvend", "Fend off", "Misdirect"), a goal card with NEXT / "TO MOVE ON", hover text for every stat,
status and rule pill. The per-world flavour is genuinely funny and consistent (citing paragraphs at a
troll bureaucrat; a yellow triangle "blended away by Broad Stroke"). The engine never confused me about
*what* happened: the log always says who hit whom for how much.

The middle of a run is where it stops being fun. Maps are 44×32 to 56×40 with the exit in the opposite
corner, sight is ~7 tiles, and most turns are spent revealing empty floor; a stretch takes 50–90 turns of
which 10–15 are decisions. Combat is a d20 coin-flip at level 1 against AC 12–14 enemies: I saw streaks
of 3, 4, 5 and 6 consecutive misses, and single enemy hits of 8–14 (30–100 % of my remaining HP). **All
five runs ended in death at stretch 2 or 3, three of them on Gentle, none to the boss.** Every death was
*explained* but none felt *deserved*, and in three of them the tool that would have saved me (a strong
attack item, a pastille, the exit under my feet) was available and unsignalled.

**Top 5 changes I would make first**

1. **Make the player's attacks reliable.** Player hits on d20 ≥ 5 (or always hit, with variable damage);
   keep misses for enemies. Six point-blank misses in a row killed run 1; five in a row cost run 2 half
   its HP against an 8 HP tick. This is the single largest "the game is cheating" moment and costs
   nothing in clarity to fix.
2. **Cut the walking in half.** Smaller areas (~30×22) or twice the density; no empty dead-end rooms;
   exit within ~25 steps of the start with the key item on the way, not in the far corner. Stretch 1 of
   the western was 83 turns, 11 of them meaningful.
3. **Fog as memory, not blindness.** Keep remembered tiles (works well), raise sight to ~10, reveal a
   whole room on entry, let click/tap travel head into unexplored space, and never let an enemy
   "appear" (GM event) where the player cannot see it.
4. **Signal the strong move.** The heal slot already glows "press 3" when Blood is low; do the same for
   the best attack item when an enemy is adjacent after 2–3 turns of fighting (Ricochet Shot and
   Complementary Flash each ended a fight in one turn that had cost me 15+ HP), for the exit button when
   HP is low, and for Persuade odds.
5. **A real second chance on Gentle.** The Drove's "The Herd Catches You Once" rule (first death becomes
   half HP) is the right design: make it the Gentle default across worlds. Together with a red screen
   vignette at < 35 % HP (the HUD badge is easy to miss) this removes most "unfair" deaths without
   touching balance numbers.

## 2. Runs

| # | World | Diff. | Viewport | Outcome | Turns | Wall time | How it felt |
|---|---|---|---|---|---|---|---|
| 1 | The Rain Broker of Sweetwater (weird western, EN) | Gentle | 1280×800, mouse+keys | **Died** standing on the stretch-3 exit tile, turn 239, to a Tinplate Prospector (one 9-damage hit, then 6 misses in a row) | 239 | ~25 min | Great start (trader, dowsing rod, preacher heals you). Long dusty walks; ranged aim mode is fun once found; death was a coin-flip with the exit prompt on screen. |
| 2 | The Long Drove (alien ecology, EN) | Normal | desktop | **Died** leg 2, turn 114, to a Lamina Fluke (crit for 8 at 9 HP) | 114 | ~12 min | Best rules presentation of all five (every pill explained, symbiont rule is clever). Goad melee is a slog: 8 HP ticks took 6–10 turns each. Healing supply too thin for Normal. |
| 3 | Trolldirektoratet under Dovre (NB, bureaucracy) | Gentle | 390×844 phone, touch | **Died** instance 3, turn 464, to Nemndleder Skrubb (crit for 14 = exactly my remaining Tålmodighet) | 464 | ~35 min | Tap-to-walk works, "siterer paragrafer" fights are quick and funny, the GM line "Kanskje en kopp kaffe?" was perfect — but my thermos was already gone. Mis-taps on the floating rotate buttons silently turned the camera; a visible enemy could not be tapped ("Ingen kjent vei dit"). 464 turns is far too long for a phone session. |
| 4 | Pianissimo (silent heist, EN) | Normal | desktop | **Died** movement 3, turn 212, "outfoxed by Stray Semiquaver" two turns after Hush hit 0 and a Night Watchman appeared | 212 | ~18 min | Stealth stats (Hush, Composure) well explained; one-tile parquet corridors read well. Hush fell to 4/10 across a transition with no warning, then 24 → −1 Composure in two turns. Items used: 0 — nothing nudged me to use the pastille or the smoke pellet. |
| 5 | Unsigned: The Last Yellow Triangle (abstract, EN) | Gentle | desktop | **Died** region 3, turn 210, to Broad Stroke + two Gesso Moths while leaving a conversation | 210 | ~20 min | Clearest world: few enemies early, a visible Varnish clock, a healer by the start. Region 2 cornered me in a one-tile dead end with a boss; Persuade failed with no explanation; the Flash in slot 5 then one-shot it. Region 3 had no healing within reach at 12/32. |

Also opened on the phone: Gullkalven (NB teen drama) to check the dialogue and trade bottom sheets
(`09`–`11` screenshots are from the troll run; the sheets themselves were clean and readable).

Turn accounting (run 1, counted from the log): 239 turns = 1 prologue, 4 dialogue, ~31 attacks/item
uses, 6 pick-ups, and ~195 moves or waits. Around 80 % walking.

## 3. Findings

Severity is given as *fun / clarity*: H = high, M = medium, L = low.

### 3.1 Rules

- **Stat abbreviations work on desktop.** BLD/INS/GRT, SAP/POL/HAU, CMP/BRT/BRG, PIG/GLT/WGT all
  have short, good hover text ("Footing — Balance on a moving hill: to-hit, dodging and slings"). On
  the phone there is no hover and no obvious tap target; I never saw a stat explained there. **M/M.**
  Suggestion: tap a stat on phone shows the same text as a toast; the how-to card names the HP and MP
  words once ("Your Blood is your health").
- **Rule pills are explained on hover and in the Rules panel.** "Drought" says "every new stretch leaves
  you parched", Parched then appears as a status with a countdown. "The Varnish Creeps" is specific
  (every 15 turns +1, new region −15, 70 = Tacky, 100 = lose). **Keep.**
- **Hidden terrain damage.** Walking through a prickly-pear bush costs 1 Blood per turn; the bush tile
  has no hover text and the log says only "takes 1 Blood" (`05-western-bush-damage-unexplained.png`).
  A player sees HP drain and blames the game. **H clarity.** Suggestion: tile hover/long-press text
  ("Prickly pear: 1 Blood per turn"), name the cause in the log, and keep click-travel off hazards.
- **Boss escape with no trail.** Sabine Lark used "Smoke and Mirrors" at 5 HP and reappeared 25 tiles
  away in fog (`06-western-sabine-vanished.png`). Nothing says where she went or that she is still a
  threat. **M/H.** Suggestion: GM line with a direction, or an edge marker.
- **To-hit is opaque.** +2 vs unaware, +level/2, AC 11–14: at level 1 a Rattler (AC 13) is hit on 11+.
  The actor tooltip already shows "Even match"; extend it to hit chance ("hits you 55 %, you hit 45 %")
  so a streak at least reads as bad luck rather than a bug. **M/M.**
- **Resource stats with hidden thresholds.** Hush (heist) at 0 summons a watchman; nothing warns at 3 or
  4, and it carried over to a new movement at 4/10. Varnish (abstract) is better because the bar is
  labelled with the lose condition. **M/H.** Suggestion: a "Hush low" badge like "Blood low".

### 3.2 Goals

- **The goal card is the best thing in the UI.** GOAL / NEXT / "then:" plus "show how to win" with
  checklist conditions and "YOU LOSE IF"; "TO MOVE ON: Get Lodestone Gate Key — needed for: Unlock the
  mine gate" tells you exactly what to do; it updates the moment you pick the key up. **Keep.**
- **"Explore X and find the way on" gives no direction, and the exit is always the far corner**
  (start 42,4 → exit 3,29; 41,23 → 11,2; 5,28 → 40,3; 39,4 → 2,27; 40,19 → 6,7). Under fog that is
  40–80 turns of guessing per area. **H fun.** Suggestion: after ~20 turns in an area (or always on
  Gentle) show a faint compass/edge marker toward the exit; or let reveal items (dowsing rod) mark it.
- **Where is the key item?** "Get the Bezoar" / "Skaff DT-1" has no location hint. Friendly NPCs do
  give one in text ("Skjema DT-1 ligger hos vettene borti gangen", "a stone, deep past the fluke-folds")
  — good — but it is not carried into the goal card. **M/M.** Suggestion: once heard, append the hint
  to the NEXT line.
- **Fiction vs geometry.** The abstract goal says the signature is in the *lower right corner*; every
  exit was top-left on screen. Harmless, but a player who takes the text literally walks the wrong way.
  **L/M.**

### 3.3 Results and feedback

- **Combat log is specific and well condensed** ("Company Deputy clubs Dolores Aguila for 3 Blood",
  "×3"); floating damage numbers appear over targets; kills give "+silver +Reputation" lines. **Keep.**
- **Miss streaks dominate the feel of combat.** Western: 3, 3, 4 and 6 misses in a row; Drove: 5 in a
  row; heist: 3 in a row; abstract: 2–3 per fight (`04-western-miss-streak.png`). **H fun, H clarity.**
  See top change 1.
- **Burst damage with no warning.** Prospector 9, Fluke crit 8, Watchman/Semiquaver 25 over two turns,
  Skrubb crit 14, Broad Stroke 6 + moths 2+2+4 in one turn. Each was 30–100 % of remaining HP. Gentle
  multiplies enemy damage by 0.8, which does not change the shape of the problem. **H fun.**
- **"Company Deputy appears" (GM event) with nothing new on screen** — it spawned in fog six tiles
  away. **M/M.** Spawn in view or show an edge marker.
- **Death on the exit tile** with "Move on — Ride an ore cart…" showing (`08-western-death-on-exit-tile.png`).
  A new player does not know that leaving ends the fight. **M/M.** Suggestion: when HP is low and the
  exit is under you, pulse the context button and label it "Escape".
- **"Blood low — press 3" is the right idea** but lives in the HUD corner; I registered it only in the
  DOM dump (`07-western-blood-low-after-rattler.png`). **M/M.** Add a screen-edge vignette.
- **Level-up cards are clear** (three perks, numbers as pills). **Keep.**
- **Persuade gives no odds and no reason.** Cornered by The Crosshatch Knot at 10/28 I pressed `p`:
  "The Crosshatch Knot is not convinced", then it hit me. No stat named, no chance shown. **M/H.**
  Suggestion: "Persuade (Angle 14 vs 12 — likely)" on the button, and a one-line reason on failure.
- **The win button was in my bar all along.** Complementary Flash (slot 5) did 10 and ended a fight that
  had cost me 18 HP of bump attacks; Ricochet Shot did the same in the western
  (`12-abstract-cornered-win-button-unused.png`). The slot glow only fires for "fix a danger" items.
  **H fun.** Suggestion: glow the strongest attack when an enemy is adjacent and the fight has lasted
  3+ turns, with a "press 5" badge like the heal hint.
- **Items used with no visible effect.** On the phone run both thermos charges vanished (slot became
  "tom") with no log line and no HP change I could see; later the GM said "Kanskje en kopp kaffe?" when
  I had none. Please verify; if a use is swallowed by a full bar or cooldown, say so in the log. **M/H.**
- **GM choice cards** ("A dust devil drops a handbill: 1 Take the Stick of Dynamite / 2 Leave it be")
  are clear, but the fiction and the reward rarely connect (a handbill gives dynamite; a heelbiter
  nipping a calf gives lichen curd). Harmless; makes the GM feel random. **L/L.**

### 3.4 Space and pacing

- **Maps are big and mostly empty.** 44×32 (~1000 floor tiles, 7 items) and 56×40. Stretch 1 of the
  western: 83 turns, 11 of them combat/talk. Stretch 2: 90 turns. Troll instance 1: 185 turns on the
  phone. **H fun.**
- **Dead-end rooms.** A 4×5 room with one door and nothing in it: 6 turns in, 6 turns out. The abstract
  region 2 had a one-tile dead end where the boss cornered me. **M fun.**
- **Click-travel stops constantly** ("stops when something appears"), and only reaches tiles you have
  already seen, so crossing a fogged map is click, wait, click, wait. **M fun.** Suggestion: clicking an
  unseen tile means "walk toward"; stop only for *hostile* sightings and HP loss.
- **Zoom is nearly useless**: six `-` presses barely change the view and there is no overview
  (`02-western-max-zoom-out.png`). With remembered tiles there is no reason not to allow zooming out to
  the whole explored area. **M/M.**
- **Transitions are quick and well marked** (arrival card, new NEXT line, context button on the exit).
  **Keep.**
- **Conversations do not pass turns but enemies still gather.** Leaving the Pentimento dialogue I was
  adjacent to three enemies that had walked up while I read. Not wrong, but surprising. **L/M.**

### 3.5 Fog of war

- **What works:** remembered floor stays visible (darker), unseen tiles are black, hostiles out of sight
  are hidden, the "X" marker on an unknown click target. The mine and the heist galleries do get some
  tension from it.
- **What hurts:** sight ~7 (less under "Dust on the Wind") on a 44-wide map means most turns reveal
  empty floor; enemies kite from the fog edge (Claim Jumper shot me from 4 tiles while I could not click
  him); "Reveals the surroundings (radius 14)" items reveal more than the camera shows, so the effect is
  invisible; GM-spawned enemies "appear" out of sight; on the phone a visible enemy in the next room
  cannot be tapped because the door tile between is unseen (`10-phone-visible-enemy-no-known-path.png`).

### 3.6 Controls

- **Keyboard is complete and discoverable** (`?` help is thorough; the how-to card explains
  bump-to-attack with the world's own verb). **Keep.**
- **Aim mode is hidden.** Pressing the weapon's slot key opens "Choose a target — arrows or click, Enter
  confirm", the only way to shoot an enemy that is not adjacent. I bumped into the deputy for 3 turns
  before discovering it. **M/M.** Suggestion: when a ranged weapon is equipped and an enemy is in range,
  badge the slot "press 1 to shoot".
- **Hover panel sticks after click-travel** and covers a dialogue option
  (`03-hover-panel-covers-dialogue.png`). **L/M.** Hide it when a dialogue opens.
- **Phone: floating rotate buttons sit over the map.** A tap on a right-edge tile hit the rotate button,
  the camera turned 90°, and every later tap and arrow went the wrong way with only "Sperret ×44" as
  feedback (`11-phone-camera-rotated-by-mistap.png`). **H clarity on phone.** Move rotate into the
  toolbar, or require two-finger twist.
- **Phone: context buttons overflow** at 390 px ("Overtal Evig ventende…", "Bruk Papirhaug", "Let",
  "Vent" overlap, `09-phone-context-buttons-overflow.png`). **M/M.** Wrap or scroll the row.
- **Phone: tapping a far hostile says "Ingen kjent vei dit"** with no path drawn; it reads as "you cannot
  attack". **M/M.**
- **Phone: long-press inspect showed nothing** on a hostile with synthetic touch; verify on a device.
  **L/M.**
- **Bumping a prop uses it** ("Ottilie Graf uses Display Case … a tin of lozenges") and doors open on
  bump — both good, but click-travel treats props as walls with a bare "Blocked". **L/L.**
- **Right-click / Enter on a slot explains the item**, including "YOUR NOTES: You felt better (+10)".
  **Keep.**

### 3.7 Difficulty feel

- Five deaths out of five runs, reached stretch 3/4, 2/4, 3/4, 3/4, 3/4. None to the final boss.
- Pattern in every death: 2–4 turns of misses, then one or two enemy hits worth 30–100 % of remaining
  HP, with a consumable or escape available and unused.
- Healing is scarce relative to the fight count: run 1 had a 3-charge canteen and 2 tonics for ~20
  enemies; run 2 had 2 curds + 1 dew for 15; run 5 had 2 dabs for 17. Traders sell heals at 6–10 when
  you hold 12–20.
- Nothing was *unexplained* — the log always named the attacker and the amount — but the *variance*
  feels unfair, and Gentle does not feel gentle. **H fun.**

### 3.8 UI and readability

- Start screen, prologue, how-to card: clear and attractive (`01-western-first-view.png`).
- Trade screen: unaffordable items greyed, prices and your purse shown; on phone it is a clean bottom
  sheet. **Keep.**
- The log panel truncates long lines with "…" on desktop; on phone it is a two-line ticker that works.
- Prologue card overlaps the goal card's NEXT line (heist, abstract). **L/L.**
- "Harmless" as the threat badge on your *own* hover panel reads oddly. **L/L.**
- Norwegian text is natural and funny ("Erklæring om at du ikke er geit"); no untranslated strings.

## 4. Recommendation: fog of war and area size

**Fog of war: keep it as memory, remove it as blindness.** Remembered tiles, hidden unseen enemies and
the "unknown target" marker all earn their place. What slows play is the small radius on a large map
plus the rule that travel only goes where you have already been. Concretely: base sight 10–12 (world
rules such as "Dust on the Wind" shrink it from there); reveal a whole room when you step into it;
click/tap travel into unexplored space with "walk toward" semantics, stopping only for hostiles and
damage; GM spawns always in view or with an edge marker; a zoom-out that shows all explored tiles.
Removing fog entirely would be fine for Gentle, but the memory model with a bigger radius keeps a little
mystery at no cost to pace.

**Area size: halve the walking.** Either ~30×22 areas, or keep 44×32 but double the density of things
(items, NPCs, props to bump) and remove rooms with nothing in them. Place the exit within ~25 steps of
the start along a route that passes the key item, and let the exit be at a *different* side each
stretch rather than always the far corner. A 15-minute run should be four stretches of ~40 turns, not
four of ~90.

## 5. What works and should be kept

- Goal card with NEXT / "then" / TO MOVE ON, the "how to win" checklist, arrival cards, and context
  buttons on exits. This chain is better than most commercial roguelikes.
- Hover tooltips for stats, statuses, rule pills and items ("Press 3 to use", "YOUR NOTES").
- The per-world "how to play" card that names the conflict verb, the equipped item and the lose
  condition in the world's own words.
- Per-world flavour everywhere: verbs ("siterer paragrafer", "hums a pure A"), currencies ("gebyrmerker",
  "spore-beads"), end-screen prose, GM asides ("Rain's not stolen. Rain's held hostage.").
- Level-up cards; the "Blood low — press 3" hint; trade screen; "×N" log collapsing; floating damage.
- Friendly NPCs that heal, hint and trade in one click; neutral NPCs that talk when you pass.
- Phone layout basics: tap-to-walk, bottom-sheet dialogue and trade, big context buttons.
- The Drove's "The Herd Catches You Once" rule and the abstract world's labelled Varnish clock: both are
  models for how to make a rule legible.

## 6. Bold ideas (change rules or numbers; marked as such)

- **(Bold) No player misses.** Player attacks always hit for variable damage; "miss" exists only for
  enemies. Fights become 2–4 turns of decisions rather than 6–10 of dice.
- **(Bold) Damage preview on hover.** Hovering an enemy shows "you: 3–8, it: 2–5 per turn, ~3 turns to
  win". Trades depth for clarity, which is the owner's stated priority.
- **(Bold) One second chance per run on every difficulty**, narrated in-world (the mossback scoops you
  up; the preacher drags you into the church; a troll stamps "utsatt"). Brutal keeps permadeath.
- **(Bold) Auto-explore key** (common in roguelikes): walks to the nearest unexplored tile and stops for
  anything interesting. Removes almost all dead time without touching map size.
- **(Bold) Exit compass after 20 turns in an area**, drawn as a faint world-flavoured cue (dust trail,
  ink line, rail), rather than a UI arrow.
- **(Bold) Enemies telegraph their big hit** one turn ahead ("Skrubb leafs to the final page…") so a
  14-damage crit can be answered with a heal, a trick or a step back.
- **(Bold) Half the enemy count, same total HP, more NPCs and props.** The worlds are at their best when
  something *talks*; the empty corridors between fights are where the fun leaks out.
- **(Bold) Always-glowing best action.** One slot pulses at any time: heal when low, strongest attack
  when adjacent, reveal item when lost, exit when standing on it. The player learns the hotbar by
  following the glow.
- **(Bold) Run length budget per difficulty.** Gentle = 3 short stretches (~35 turns each), Normal = 4,
  Hard/Brutal = 4 long. The same world spec, sliced differently.
