# Unbounded Effect grant_xp overflowed the stack in checkLevelUp (RangeError crash)

- Severity: major (M5 review round 2, extreme values)
- Area: src/engine/progression.ts, src/schema/world.ts Effect grant_xp
- Status: fixed

## Evidence
Effect `grant_xp` was `z.number().int().min(1)` with no max and growth.curve may be 1.
`checkLevelUp` called itself once per level whenever no perk choice was pending (always, once all
perks are taken), so fixture-western with curve 1, firstLevelXp 5 and an on_turn grant_xp of 1e9
threw "RangeError: Maximum call stack size exceeded" from public step(). The GM "effect" action
carrying the same nested grant_xp crashed the same way
(tests/review/m5/r2-extreme-values.test.ts "grant_xp has no upper bound").

## Fix
- `checkLevelUp` is a loop, not recursion: it levels while xp suffices and no perk choice is
  pending, at most `MAX_LEVELS_PER_CHECK` (50) levels per call; xp beyond the cap is dropped to
  just below the next level, so the bar never shows millions of unspendable points. Normal play
  (perk choices pending, several levels from one grant) behaves exactly as before.
- `grantXp` ignores non-finite amounts (Infinity / NaN) as well as non-positive ones.
- Schema: Effect grant_xp is bounded at max 1000 (like ActorDef.xp), which also bounds the GM
  "effect" action (it takes world Effects).

## Regression tests
tests/engine/m5-endings-xp.test.ts "huge xp grants" (moved from tests/review/m5/r2-extreme-values.test.ts):
schema bound (world and GM effect); a 1e9 grant gains exactly 50 levels without throwing; an
unvalidated world with on_turn grant_xp 1e9 plays 40 turns (taking perks) without throwing;
ordinary multi-level grants and the pending-perk stop are unchanged; Infinity/NaN/0/negative ignored.
