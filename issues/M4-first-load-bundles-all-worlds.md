# First load bundled all 18 world specs (static main chunk 1.78 MB)

- Severity: major
- Area: client (worlds.ts), build
- Status: fixed
- Source: BUILD_LOG.md [M4/app-shell] First-load size; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
The static build's main chunk was 1.78 MB (542 kB gzip) because worlds.ts imported every World Spec eagerly,
which is slow on phones (DoD #12).

## Fix
A light sync index (each JSON's meta + palette) feeds the start screen; the full specs are lazy `?raw` chunks
loaded and validated on play. Main chunk 0.82 MB (266 kB gzip). three.js is in the lazy render chunk.

## Regression tests
tests/shell/storage-shell.test.ts (worldIndex / loadWorld); e2e/modes.spec.ts and e2e/m3-gate.spec.ts start worlds from the lazy chunks.
