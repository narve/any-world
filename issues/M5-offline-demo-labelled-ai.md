# Offline demo marks a recorded world as "LAGET AV KI" (made by AI)

- Severity: minor
- Area: client (src/client/storage.ts, src/client/main.ts start view, src/client/ui/components/screens.ts, i18n catalogs)
- Status: fixed
- Source: M5 Norwegian review round 1 (tests/review/m5/nb-review-r1.spec.ts)

## Evidence
docs/archive/progress/M5/nb-r1-demo-start-recent.png: after "Lag verden" with the offline demo generator (preset mock),
the picked recorded world "Trolldirektoratet under Dovre" was listed under "Dine verdener" as
"FOLKEEVENTYR-BYRÅKRATI · LAGET AV KI", while the status line said "Ingen KI brukes". The world choice itself was
right.

## Root cause
The offline generator keeps its copy with `source: 'generated'` (it does run the real generation pipeline) and
`origin: <recorded world id>`. The start view mapped every non-imported world to "made by AI" and ignored
`origin`.

## Fix
- `storage.recentSource(meta)`: imported → 'imported'; a kept world with `origin` → 'demo'; else 'generated'.
- `RecentWorldView.source` accepts 'demo' (backwards-compatible view-model addition); main.ts uses recentSource.
- `screens.recentSourceLabel()` maps 'demo' to the new catalog key `start.recentDemo`: "recorded demo" in English,
  "innspilt demo" in bokmål.

## Regression tests
- tests/shell/m5-shell-fixes.test.ts (recentSource for each case; the label in en and nb; the demo label never says AI/KI).
- e2e/modes.spec.ts "offline demo generator…": both kept worlds show "recorded demo", never "made by AI".
