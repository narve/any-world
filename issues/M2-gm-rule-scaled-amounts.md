# Scaled amounts in GM rules were priced as if every stat were 12

- Severity: major
- Area: engine (src/engine/rules.ts avgAmount / effectHarm)
- Status: fixed

## Evidence
tests/review/m2/round3.test.ts 'scaled amounts assume every stat is 12'. {base:-12, scale:{stat:'hp', factor:1}} every 5 turns was estimated at 0 and accepted on gentle; evalAmount scales by the holder's live hp (30 in testWorld), so each firing dealt 18.

## Fix
New `statCeiling(world, stat)`: the most a player stat can plausibly reach (hp/mp: start + 10 levels of hpPerLevel/mpPerLevel; str/dex/int/ac: start + 8; sight: +6; speed: 200; custom resource: its max; unknown ids: 0, matching stats.getStat). The scale term spans [min(0, f·ceiling), max(0, f·ceiling)] since the live stat lies between 0 and the ceiling. Hurtful amounts (damage, draining resource) are priced at the end worst for the player; helpful ones (heal, refilling resource) at the end that gives least. So a scaled heal earns no sure credit beyond its base, and a scaled damage costs its full ceiling.

## Regression test
tests/engine/gm-rules-harm-r3.test.ts: the scaled repro on gentle (refused, no hp lost), harm at the top / help at the bottom of the scale, statCeiling of a custom resource is its max.
