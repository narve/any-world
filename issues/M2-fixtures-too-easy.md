# Teen, western and dream fixtures are too easy on Normal (explorer 78-89%, dream talker 99-100%)

- Severity: major
- Area: content (content/worlds/fixture-teen.json, fixture-western.json, fixture-dream.json)
- Status: fixed (teen, western, dream explorer win rates now in the normal band). The dream talker result is explained below and is still high.

Also covers "Dream world is too easy on Normal" (minor, playtest r1), which has the same root cause.

## Evidence
`npm run sim -- --seeds 100 --bots explorer,cautious,talker,random --analyse` gave these explorer win rates: teen 82%, western 78%, dream 86%. All three got the verdict TOO_EASY against the normal band (25-60%). The dream talker won 100/100. Almost every death came from the final boss. Teen's first area offered 85.9 expected healing against 58.1 damage, and western's offered 72.5 against 60.4.

## Root cause
- **Teen.** Monday had a lot of healing: iced tea weight 20, the Coach healer and hp regeneration every 6 turns. The rank-and-file hostiles (Group Chat Lurker 1d4, Senior Prankster 1d6+1) could not wear the player down before Friday. Mags (45 hp, 1d6+2) was the only real check.
- **Western.** Main Street was heavy on healing (sarsaparilla 20, laudanum 8, snake oil 10). The Dry Creek and Lodestone hostiles hit for 1d4 to 1d8+1, and Absalom Vane had only 52 hp.
- **Dream.**
  - Rank-and-file shapes were very weak (1d4, 5-10 hp).
  - Each layer refilled 35 Saturation, and tubes and pigment pools were plentiful.
  - The Erasure (speed 90, guard radius 4) was easy to walk around.
  - The talker's 91-100% does not come from the pacifist route. A diagnostic over 40 seeds (onStep tally) found that only about 10% of its wins used the horizon flag. The rest came from kiting the Erasure with the `complementary` glare ray, which is the boss's designed weakness (glare ×1.5), and from persuading the summoned Washes of Grey. The explorer instead fights the Erasure in melee.

## Fix (hand-tuned, then checked with the simulator)
- **Teen.**
  - Healing: hpRegenEvery 6 → 8. Monday healing weights cut (iced tea 20 → 8, cookie 10 → 5, admirer note 5 → 2). Wednesday healing weights cut (iced tea 15 → 10, cookie 8 → 5, note 6 → 3). Coach is no longer placed on Monday; she is still at the Friday assembly.
  - Hostiles: Lurker 8 hp, 1d4+1. Prankster 16 hp, 1d6+2. Hall Monitor 1d4+2. Paparazzo 1d4+1. Mags 62 hp, 1d8+3.
  - More spawns: Monday Prankster min 2 and Hall Monitor max 3; Wednesday Prankster max 5 and Surveyor min 1.
- **Western.**
  - Main Street healing weights: sarsaparilla 20 → 8, snake oil 10 → 5, laudanum 8 → 3. Dry Creek sarsaparilla 15 → 10.
  - Hostiles: Tinplate Prospector 19 hp, 1d8+2. Claim Jumper 12 hp, 1d6+2. Coyote, Buzzard and Dust Devil 1d4+1. Lodestone Mole 1d6+3. Absalom Vane 66 hp, 1d8+3.
- **Dream.**
  - Saturation: drying-time area refill +35 → +25, pigment-pool density ×0.6. Tube-of-rose and linseed weights cut by about 40%.
  - Hostiles: every rank-and-file shape gets +1 damage. Eel 20 hp, 1d6+3. Bloom 15 hp, 1d6+2. Acute Angle 12 hp, 1d6+2. Grey Wash 11 hp. Perspective Warden 26 hp, 1d8+3, with 2 always present in layer 3, where it guards the Note of Blue.
  - The Erasure: speed 110, guard radius 6, 76 hp, 1d8+4. Wash Out now hits for 2d4+3 every 3 turns. The Vanishing Point always has 3-5 Washes of Grey and at least 1 Acute Angle around the Last Brushstroke.

## Result
Seeds 1-100, no GM, `npm run sim -- --seeds 100 --bots explorer,cautious,talker,random --analyse`:

| world | explorer | cautious | talker | verdict |
|---|---|---|---|---|
| teen | 55% | 19% | 61% | ok |
| western | 44% | 41% | 57% | ok |
| dream | 58% | 49% | 91% | ok |
| ship (startCurrency only) | 51% | 43% | 58% | ok |

Seeds 101-300 with the scripted GM (`--gm`), explorer: teen 45%, western 59%, dream 45%, ship 62%. Over seeds 1-200 while tuning, explorer was teen 52%, western 48% and dream 55%. There were 0 crashes and 0 soft-locks, and the early areas now cause some deaths (teen area reached 3/1/96).

## Known leftovers
- **Dream talker (~90%).** Superseded: this diagnosis was wrong, and the talker won by persuading ~17 hostiles per run. Fixed in M2-dream-talker-dominant.md (talker 63%). Original note: this is a bot strategy that kites the boss with its glare weakness, so it counts as skilled play rather than a free pacifist route. Making the glare resistance ×0.5 dropped every bot to 7-36%, which was too much, so the designed weakness was kept. Further fixes would need either a persuade-DC knob for non-NPC hostiles (engine/schema) or a sim bot change.
- **Teen cautious (19%).** It is low because the cautious bot reaches Mags under-levelled. The explorer is the bot the band is defined for.

## Regression test
tests/content/fixtures-m2.test.ts, "fixture difficulty (normal)". This covers the first-area damage-vs-healing guard, the final-boss straight-fight risk of at least 1.3, and the dream area refill of at most 25.
