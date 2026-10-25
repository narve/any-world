# New players still die on Gentle (1 win in 10 runs, playtest round 3)

- Severity: major
- Area: content (content/worlds/heist-silent-vault.json, fixture-western.json, fixture-teen.json, corporate-merger-kitchen{,-nb}.json, folk-horror-scarecrow-wedding.json, nb-nordisk-noir-tromso.json)
- Status: fixed on the content side. Gentle newbie win rates rose by 3 to 13 points in the five worlds that killed the tester. The difficulty profile itself is engine-side; see "Remaining".
- Follows issues/M5-new-player-deaths.md (round 2), which added the `newbie` bot and the new-player gate.

## Evidence
Desktop playtest, round 3:

- Hollin Moss (Normal) died in field 3.
- On Gentle, six runs died: Pianissimo twice, Rain Broker, Neutral Ground, Lowmoor and Whale Fall. Whale Fall was won only on the replay.
- **Pianissimo.**
  - A Night Watchman (10 HP on gentle) took the player from 28 to 8. The tuning fork missed 7 of 13 swings.
  - An empty Hush meter summons a Night Watchman and refills only +5, so it empties again five hits later. Each new watchman's hits drain Hush further. This death spiral happened next to the Wolf Tone, which sat in the same "far" corner as the Prompter's Last Cue (the encore route item).
- **Lowmoor.** A pair of Senior Pranksters took the player to 3/34.
- **Rain Broker.** Three things together left the player at 18/42 entering stretch 3:
  - Drought (no regeneration),
  - Parched for 5 turns on every area arrival,
  - range-6 kiting riflemen that outrange the range-5 Peacemaker.

The gate passed every world before this change, but its floors (gentle ≥ 50%) are well below what a human new player experiences. Baseline, newbie bot, seeds 7001–7100:

| world | gentle | normal |
|---|---|---|
| heist (Pianissimo) | 69 | 40 |
| western (Rain Broker) | 78 | 30 |
| teen (Lowmoor) | 73 | 38 |
| corporate (Neutral Ground) | 88 | 39 |
| folk-horror (Hollin Moss) | 76 | 44 |
| deep-sea (Whale Fall) | 91 | 65 |
| noir (Tromsø) | 78 | 51 |

Over 200 seeds, teen's gentle deaths were mostly from the final assembly. Mags Calloway's "Rally the Squad" summons 2 range-3 Group Chat Lurkers, and up to 3 more spawn from the table.

## Root cause
- **Hush (heist).** The meter's `onEmpty` both summons a hostile and refills only half the meter. Nothing limits how often it can fire, so a fight that is going badly produces more watchmen, and each watchman empties the meter faster.
- **Placement.** `far` picks from the 10% of tiles farthest from the start. A `far` hostile and a `far` key item therefore end up side by side.
  - heist area 3: Wolf Tone with the Prompter's Last Cue.
  - noir area 4: Ragnhild with kapteinens brev.
  - In both cases the alternative-to-the-boss route item lay under the boss.
- **No out-of-combat recovery (western).** The only world with `noNaturalHpRegen`. Every area arrival cost 5 hp (Parched), and no heal was guaranteed on the trail. Claim jumpers (2–4 guaranteed in area 2) outranged the starting gun.
- **Crowds of strong melee.**
  - teen area 2 guaranteed 2–5 pranksters (16 hp, 2+1d6 +1 str, speed 110) plus 2–5 lurkers.
  - corporate area 3 guaranteed 2–4 rumour mills and 2–4 ambushers.
  - folk-horror's tower allowed 4 kiters and 3 rope-ringers.
- **Boss adds (teen).** Mags summoned 2 lurkers at the start of the fight.

## Fix (content)
- **heist-silent-vault**
  - *Whisper Floors* (the Hush drain on hurt) only drains while flag `watch-roused` is false.
  - Hush `onEmpty` summons one Night Watchman, refills Hush to full (10) and sets `watch-roused`.
  - A new `on_area_enter` trigger on the same rule clears the flag.
  - Result: an empty Hush rouses the watch at most once per area, at every difficulty. The rule description says so.
  - Night Watchman AC 12 → 11 (the fork hits on 9+ instead of 10+).
  - Wolf Tone removed from the area-3 spawn table, so only the placed one remains. Prompter's Last Cue moved `far` → `centre`.
  - Vault: rank-and-file watchmen max 2 → 1, and a sacher slice is placed `near_start`.
- **fixture-western**
  - Arrival Parched 5 → 2 turns. The rule description mentions the bottle by the trail.
  - A sarsaparilla (8 hp) is placed `near_start` on the flats and in the galleries. This is the out-of-combat recovery for a no-regeneration world.
  - None is placed in the cistern: a guaranteed heal there drops the static boss risk below the fixtures-m2 guard (0.88 → 0.72).
  - Claim-jumper range 6 → 5 (the Peacemaker's reach). Flats: claim jumpers 2–4 → 1–3, coyotes 3–6 → 2–5.
  - Galleries: tinplate prospectors 2–4 → 1–3.
  - Random pickups on the flats 8 → 6 and in the galleries 7 → 5, so the explorer does not run away with normal/hard.
- **fixture-teen**
  - Senior Prankster hp 16 → 14, damage 2+1d6 → 1+1d6. Empty house: pranksters 2–5 → 1–2, lurkers 2–5 → 2–3.
  - Rally the Squad summons 1 lurker instead of 2. Assembly lurkers max 3 → 2, and a polaroid is placed `near_start`.
  - itemCount 7/8/4 → 5/6/3. The explorer was at 91% on normal (TOO_EASY), and fewer random pickups is the lever that costs the explorer more than the newbie. Raising Mags' hp cost the newbie 10 points on gentle and the explorer nothing.
- **corporate-merger-kitchen (en and nb)**
  - Grapevine: rumour mill 2–4 → 1–3, watercooler whisper 2–4 → 1–3, reply-all max 3 → 2, consultant max 3 → 2.
- **folk-horror-scarecrow-wedding**
  - Tower: clapperling max 4 → 2, rope-ringer max 3 → 2. Nave: barley bridesmaids 3 → 2 with the Gaffer.
- **nb-nordisk-noir-tromso**
  - Kapteinens brev moved `far` → `near_exit`, out of Ragnhild's corner.
  - `centre` made the evidence route trivial: brutal explorer 33% → 59%, TOO_EASY. `near_exit` gives 40%.

## Result
Newbie gate, seeds 9001–9200. The baseline above used seeds 7001–7100, so differences under about 6 points are noise.

| world | gentle before → after | normal before → after | explorer normal after |
|---|---|---|---|
| heist | 69 → **82** | 40 → 52 | 85% OK |
| western | 78 → **81** | 30 → 43 | 86% OK (noise) |
| teen | 73 → **86** | 38 → 60 | 87% OK (noise) |
| corporate (en/nb) | 88 → **91** | 39 → 45 | 60% OK |
| folk-horror | 76 → **82** | 44 → 50 | 83% OK |
| noir | 78 → 73 (noise; placement only) | 51 → 48 | 60% OK |

Deep-sea was not changed: it was already at 91% gentle and 65% normal for the newbie. Its death in the playtest happened on the boss, which the round-2 retune already weakened.

**Hard and brutal.** Explorer, 100–200 seeds. All OK or within noise, except:
- western hard is 68%, above the 12–65% band but within noise. It was 60% before.
- brutal: heist 35%, western 44%, teen 53% (noise), noir 40%.

## Remaining (engine owner)
The playtest asks for more than content can give. Every content change moves gentle and normal together, and the explorer's normal ceiling (85%) is already reached in heist, western and teen. These need `src/engine/difficulty.ts` or the bots:
- **Gentle hostile damage and accuracy.** Gentle's `hostileDamage` 0.8 could go to about 0.7, or gentle could add a to-hit penalty for hostiles (for example −2). Neither is a world property.
- **Small recovery in no-regeneration worlds on Gentle.** For example, a slow regen of 1 hp every 20 turns when `noNaturalHpRegen` is on and no hostile is in view. The western bottles are the content-side stand-in.
- **Gentle cap on meter-zero summons.** The heist cap is authored in the world, once per area at all difficulties. A general engine cap would also cover generated worlds. The world prompt (llm owner) could also tell authors to pair an `onEmpty` summon with a full refill.
- **Gate floors.** The gentle floor (50%) is far below the human result. Raising `NEW_PLAYER_FLOORS.gentle` to about 75% would catch these worlds automatically. This is in src/engine/balance, outside the content role.

## Regression tests
tests/content/m5-new-player-deaths-r3.test.ts (34 tests):
- **Placement guard.** In no world does an area place a `far` hostile together with a `far` key item. A key item is anything the goal or a transition needs, or anything that sets a goal flag.
- **Hush.** Played through the engine at gentle and normal: 30 hits in one area summon exactly one Night Watchman, and Hush is not drained while the watch is out. Entering the next area clears the flag, and 30 more hits summon one more. With the old content this was 5 watchmen per 30 hits.
- **Pinned values.** The western, teen, corporate (en/nb) and folk-horror values the retune relies on.

Also changed: tests/balance/m2-fixes.test.ts "tuneWorld improves a world whose NPC bosses deal ×N damage" now uses ×4 instead of ×3. The easier western flats made ×3 an "ok" world on 12 seeds, so the test no longer exercised the too_hard path.
