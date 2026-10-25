# Althing-nb: the female player is called "Læregutt"

- Severity: minor
- Area: content (content/worlds/viking-lawspeaker-althing-nb.json)
- Status: fixed

## Evidence
Steinunn Hallsdóttir has player.title "Læregutt hos lovsigemannen", and "læregutten hans" appears in meta.prompt and in the prologue intro. Steinunn is a woman: NPCs greet her with "Hallbjørns jente!". The English source has "Apprentice", which is gender-neutral.

## Fix
- player.title is now "Lærling hos lovsigemannen".
- Both "læregutten hans" became "lærlingen hans".
- No other "læregutt" remains in the file.

## Regression test
tests/content/m5-content-text.test.ts. It checks that no `/læregut/i` occurs anywhere in the world and that the title reads "Lærling hos lovsigemannen".
