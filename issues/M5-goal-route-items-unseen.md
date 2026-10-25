# Alternate win route items in earlier areas are never shown by the goal tracker

- Severity: major (M5 review round 3, desktop playtest)
- Area: src/client/guide.ts (currentStep, unmetLeaves, conditionLines), i18n catalogs (2 new keys)
- Status: fixed

## Evidence
Pianissimo, Gentle: win = has the Glass-Lark cylinder AND (Stillhart outfoxed OR flag encore-called). The flag is only set by The Prompter's Last Cue, placed in area 3. In area 3 the tracker said only "Explore Inside the Second Movement and find the way on" (`currentStep` for non-final areas looked only at the way on). No backtracking, so the easy route was lost; the player died at the 68-Composure boss. Same pattern: Neutral Ground's Grapevine (a rumour the forged agenda needs) and Whale Fall's final stretch ("HARROW-4 Coring Rig must be driven off" while carrying Brandvold's Kill Code). Screenshots: pt-desktop-r3-pian-10-goal-expanded.png, pian-21-boss.png, kitchen-05-area3.png, whale-07-killcode-aim.png.

## Fix
- `routeItemsHere(world, state)`: items lying in the current area (`state.area.items`) that a still-unmet win leaf needs — a `has_item` leaf, the item that sets a goal flag (`flagSource`), or a `has_item` its use condition asks for — and that the player does not carry. `currentStep` appends "Also here: {item} (for: {goal line})" to the step's detail (up to two, not repeating an item the step already names), in every area, as long as the item lies there.
- `unmetLeaves(state, c, depth, world)`: with the world, a flag leaf the player has *in hand* (`inHand`: its source item is carried and the item's own player-side conditions hold — checks on the use's target are left to the use) ranks as nearly done, so the final stretch prefers "Use Brandvold's Kill Code" over a fight. `actionableStep` no longer turns a target-side use check (`who: target`) into a player step.
- "How to win" / goal lines: a story flag with an item source reads "{flag line} — with {item}".
- New catalog keys (en + nb): `goal.step.alsoHere`, `cond.via`.

## Regression tests
tests/client/goal-route-items.test.ts (the review repro from tests/review/m5/pt-desktop-r3.test.ts, now against a real area-3 state), e2e/m5-client-fixes-r3.spec.ts (Pianissimo area 3 tracker text). tests/client/guide.test.ts adjusted for the "— with" line.
