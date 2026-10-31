# Rerunning the M4 e2e specs overwrites the committed docs/archive/progress/M4 screenshots

- Severity: minor
- Area: e2e specs (e2e/modes.spec.ts, e2e/mobile.spec.ts, e2e/m4-gate.spec.ts, tests/i18n/e2e/nb-play.spec.ts)
- Status: fixed
- Source: M5 DoD audit round 1

## Evidence
After `xvfb-run -a npx playwright test e2e/modes.spec.ts` (9/9 passed), git status showed 9 modified
docs/archive/progress/M4/shell-*.png files. modes.spec.ts set `const OUT = 'docs/archive/progress/M4'` unconditionally, and
so did nb-play.spec.ts, mobile.spec.ts and m4-gate.spec.ts. The M1–M3 specs were already switched in M4
(issues/M4-e2e-reruns-overwrite-screenshots.md).

## Fix
All four specs use the M3-gate pattern:
`const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M4' : 'test-results/shots/M4'` (nb-play joins it to
the repo root). Set SHOTS_TO_DOCS=1 to refresh the committed milestone screenshots on purpose.

## Regression tests
Checked by running e2e/modes.spec.ts (12/12 passed): `git status` shows no docs/archive/progress/M4 changes and the
screenshots are in test-results/shots/M4.
