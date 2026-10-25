# viewport meta lacks viewport-fit=cover

- Severity: minor (M5 review round 1)
- Area: src/client/index.html
- Status: fixed

## Evidence
index.html had 'width=device-width, initial-scale=1'; main.ts set viewport-fit=cover only after the module ran.

## Fix
The static meta now carries 'viewport-fit=cover, interactive-widget=resizes-content' (the same string setupMobile() enforces), so env(safe-area-inset-*) applies from the first paint. Still to confirm on a real notched iPhone.

## Regression tests
Static check; the safe-area CSS itself was verified by the reviewer via CDP inset emulation.
