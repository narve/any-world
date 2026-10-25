# Phone goal step and HUD strip cramped/clipped

- Severity: minor (M5 review round 1)
- Area: src/client/styles/ui.css, src/client/ui/components/hud.ts
- Status: fixed

## Evidence
Pixel troll: 'Skaff Skjema DT-1: Søknad om å få s…' clipped; strip ran together '…Venterommet Runde 1 15 gebyrmerker'. Desktop summary always one ellipsised line.

## Fix
Goal step (phones) and goal summary (all layouts) may use two lines. On phones the strip separates its parts with '·' and shows money as '¤ 15' (full text in the tip).

## Regression tests
Visual; e2e/mobile-full-run.spec.ts checks the overlay stays in the viewport at every area.
