# Pianissimo: the Hush resource never ran low (bot hoarded 12 pastilles)

- Severity: minor
- Area: content (content/worlds/heist-silent-vault.json)
- Status: fixed
- Source: BUILD_LOG.md [M3/world-heist-silent-vault]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
Browser playtest: the bot hoarded 12 pastilles and Hush stayed at 10/10, so the world's central pressure never
bit.

## Fix
The forte gives back 1 Hush instead of 2, pastille weights halved, the Echo Moth no longer drops pastilles, the
Director's hp went to 80. Sim over 200 seeds: explorer 56%, cautious 19%, talker 54%, 0 crashes.

## Regression tests
M3 gate sim (explorer 57% at 300 seeds, in band).
