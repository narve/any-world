# Grammar errors in the nb worlds (russetid, troll-direktoratet)

- Severity: minor
- Area: content (content/worlds/nb-russetid-bussen.json, content/worlds/nb-troll-direktoratet.json)
- Status: fixed

## Evidence
From the nb review:
- **nb-russetid-bussen.json**
  - areas[1].description said "En jorde ved skogkanten". `jorde` is neuter, so it should be "Et jorde".
  - items[4].description said "Tunge av knuter". It should be "Tung av knuter" (adjective, not the noun "tunge").
  - rules[0].description said "Hver 20. tur". Everywhere else the game calls a turn "runde".
- **nb-troll-direktoratet.json**
  - areas[3].description said "rød teppe". `teppe` is neuter, so it should be "rødt teppe".
  - items[1].weapon.name was "Rødt strek". `strek` is masculine, so it should be "Rød strek".
  - areas[2].description said "Over alt danser". It should be "Overalt danser".

## Fix
All six strings are corrected in the JSON. Nothing references these strings (no recordings, saves or tests), so no other files needed changes.

## Regression test
tests/content/m5-content-text.test.ts, "nb grammar fixes (M5)".
