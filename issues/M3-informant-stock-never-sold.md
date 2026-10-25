# Yams Before the Rain: a lock item sat in an informant's stock, which is never sold

- Severity: major
- Area: content (content/worlds/cyberpunk-rooftop-yams.json)
- Status: fixed
- Source: BUILD_LOG.md [M3/world-cyberpunk-rooftop-yams]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
Talker bot: 18% of runs stuck behind the Matriarch lock. The override chip that opens it was in Chidi's stock,
but Chidi was an informant, and informants never sell their stock. A heal-on-stand terrain could also be farmed.

## Fix
Chidi became a trader so the chip can be bought; the farmable heal-on-stand terrain was removed; Panel Leech
coward → wanderer; Spoof Ping cooldown 3. Sim over 100 seeds: explorer 59%, cautious 11%, talker 39%, 0 stuck.

## Regression tests
M3 gate sim (0 stuck); tests/content/prompts.test.ts (world validates).
