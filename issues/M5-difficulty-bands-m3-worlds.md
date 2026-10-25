# Gentle and brutal win rates fall outside their bands on 3 of the 8 world/level pairs

- Severity: minor
- Area: content (content/worlds/heist-silent-vault.json, folk-horror-scarecrow-wedding.json, deep-sea-whale-fall.json)
- Status: fixed. All 9 world/difficulty verdicts are now OK. Deep-sea gentle is still at the top edge of its band; see "Remaining" below.

## Evidence
Explorer bot, 100 seeds, `npm run sim -- --analyse --difficulty <d>`.

| world | difficulty | explorer | target | verdict |
|---|---|---|---|---|
| heist | gentle | 93% | 50–85% | TOO_EASY |
| heist | normal | 61% | 25–60% | top of band |
| folk-horror | brutal | 1% | 5–25% | TOO_HARD (37 of 100 runs ended in area 1) |
| deep-sea | brutal | 1–3% | 5–25% | too hard |
| deep-sea | gentle | 90% | 50–85% | within sampling noise |

The M3 worlds had been tuned only at normal.

## Root cause
- **Heist.** The only rank-and-file threat was the Night Watchman (12 hp, 2+1d4). On gentle almost nothing outside the boss could kill a careful player.
- **Folk-horror and deep-sea.** Their early areas are swarms of small hitters (1+1d3, 1+1d4).
  - The engine scales hostile damage per hit and rounds it: `Math.round(raw × 1.3)`. A 2 becomes 3 (+50%) and a 3 becomes 4. On brutal a swarm of small hits gains about +33%, more than the nominal 30%. On gentle the rounding cuts small hits by about 22%.
  - The gap between gentle and brutal is therefore widest in exactly these worlds. Brutal runs died before the boss: Banns Crow, Well-Wishing Aunt and Clapperling in folk-horror; Ghost Chimaera, Osteo-crab and Sampling Drone in deep-sea.

## Fix
The changes were tested on copies with explorer at gentle, normal and brutal over seeds 1–200 (and 201–500 for deep-sea). About 20 variants were tried. Boss-only changes moved gentle and brutal together. Changes that worked compress the spread instead: fewer and softer early hitters, a little more player hp, guaranteed healing before the boss, and a tougher boss to pay for it.

- **heist-silent-vault.** Night Watchman hp 12 → 15, damage 2+1d4 → 3+1d4.
- **folk-horror-scarecrow-wedding.**
  - Player hp 28 → 32.
  - Banns Crow hp 6 → 5, damage 1+1d3 → 1d3. Clapperling damage 1+1d4 → 1d4.
  - Hollin Moss Green: Well-Wishing Aunt min/max 2–4 → 1–3, elderflower cordial weight 4 → 6.
  - To keep gentle in band: Gaffer Hob hp 66 → 74.
- **deep-sea-whale-fall.**
  - Player hp 28 → 32.
  - Ghost Chimaera damage 1+1d6 → 1d6. Osteo-crab damage 2+1d4 → 1+1d4.
  - Apron: Ghost Chimaera min 2 → 1, Hagfish Knot min 2 → 1.
  - Rib Nave: Osteo-crab 2–4 → 1–3, Ghost Chimaera min 2 → 1, Worm-plume min 2 → 1.
  - The Marrow Within: 2 galley broths placed near the start.
  - HARROW-4 Coring Rig: hp 68 → 98, damage 3+1d8 → 4+1d8.

## Result
Seeds 1–100, bots explorer, cautious and talker:

| world | gentle (E/C/T) | normal (E/C/T) | brutal (E/C/T) | verdicts |
|---|---|---|---|---|
| heist | 74/51/83 | 40/16/50 | 8/0/12 | OK/OK/OK |
| folk-horror | 79/54/61 | 48/14/20 | 6/1/3 | OK/OK/OK |
| deep-sea | 89/49/72 | 52/22/27 | 7/1/4 | OK (noise)/OK/OK |

There were 0 crashes. One heist cautious run on brutal hit the turn cap (t/o), and none got stuck.

## Remaining
- **Deep-sea gentle.** It sits at 84–89% across seed ranges, at the top of the gentle band. Every boss hardening that brought it lower also pushed brutal under 5%, because on brutal the boss kills about half of the runs too.
- **Engine recommendation.** The real lever is in the engine and is the engine owner's call. Scaling small hits with `Math.round` amplifies brutal and softens gentle beyond their nominal ×1.3 / ×0.8. Two options:
  - carry the fractional part stochastically, or
  - scale the per-hit expected value.

  Either would narrow the spread in every swarm-heavy world. If the engine changes this, these three worlds should be re-simmed.

## Regression test
tests/content/m5-difficulty-bands.test.ts pins the properties the retune relies on. The win rates are checked with the sim command above, which is too slow for vitest.
