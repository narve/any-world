# Item effect lines on item cards, tooltips and trade rows were hard-coded English

- Severity: major (breaks DoD #11)
- Area: engine (src/engine/describe.ts), catalogs (src/client/i18n/en.ts, nb.ts), client rendering (src/client/i18n/engine-text.ts, src/client/ui/format.ts, src/client/ui/slots.ts)
- Status: fixed

## Evidence
`effectLine`/`targetingLine`/`itemEffectLines` built finished English sentences ("Deals", "Restores",
"Inflicts/Grants … (N turns)", "Target: one, range N", "Costs", "Cooldown N turns", "Charges",
"Requires", "Durability", "% chance", "while carried"). In the nb UI on nb worlds:
docs/archive/progress/M5/nb-r1-phone-troll-14-trade.png (Dagslyslykt: "Deals 2d4 Sollys damage / Inflicts
Halvforsteinet (1 turns) / Target: line, range 5 / Costs 4 Blekk / Cooldown 2 turns"); Althing trade
tooltip "Deals 1d4 Forakt damage"; Kvikklunsj "Restores 7 Tålmodighet", "Grants Kaffefart (4 turns)".

## Fix
- Engine: every line is now an `ItemEffectLine` {key, params, text, sub?} (src/engine/types.ts) with
  an `item.fx.*` key; the English templates are `ITEM_FX_KEYS` in src/engine/log-keys.ts and `text`
  is rendered from them (the English fallback, unchanged wording). `ItemView.effects` carries the
  lines next to `effectLines` (same order; effectLines = effects.map(text)), so older consumers keep
  working. Nested parts (a trigger's event and effect list, a stat-scaled amount, the ", allies"
  targeting suffix) are `sub` lines the client renders first.
- Catalogs: en.ts spreads ITEM_FX_KEYS (with ICU plurals for turns: "1 turn"); nb.ts has bokmål for
  every key ("Skade: 2d4 Sollys", "Påfører Halvforsteinet (1 runde)", "Mål: linje, rekkevidde 5",
  "Koster 4 Blekk", "Nedkjøling: 2 runder", "Gjenoppretter 7 Tålmodighet", "Gir Kaffefart (4 runder)").
- Client: `itemEffectText(line)` / `itemEffectTexts(item)` (src/client/i18n/engine-text.ts) render
  through tx(); used by `knowledgeLines` (item card, trade tip) and `slotExplanation` (slot tip).

## Regression tests
tests/engine/m5-item-fx.test.ts: every item of every shipped world gives known keys whose template
renders the English text; the reported Dagslyslykt/Kvikklunsj lines render in bokmål; no item line of
the nb worlds has English words in the nb UI; sub-lines render translated; en/nb know every key.
tests/i18n/nb.test.ts covers params/plurals of the new keys.
