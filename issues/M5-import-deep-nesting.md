# Untrusted world import crashes on deeply nested conditions (RangeError)

- Severity: major (M5 review round 2, not fixed in round 2; round 3 re-report)
- Area: src/client/world-file.ts (parseWorldFile)
- Status: fixed. Client import path refuses JSON nested deeper than 64 levels before zod; the M5 gate moved the guard to src/schema/json-depth.ts and added it to the LLM path (llm/structured.checkStructuredText), test tests/llm/structured-depth.test.ts.

## Evidence
tests/review/m5/r2-code-import-deep.test.ts: a 128 kB file (cap 600 kB) whose goal nests 3000 `not` conditions made zod's recursive Condition schema throw "RangeError: Maximum call stack size exceeded" out of `parseWorldFile`, and main.ts `importWorld` let it escape the file-input handler without a "could not import" toast.

## Fix
- `jsonDepth(value, limit)`: an iterative (stack-free) nesting measure that stops counting past the limit.
- `parseWorldFile` refuses specs deeper than `MAX_JSON_DEPTH` (64; shipped worlds are at most 11) with a typed `invalid` failure ("nested too deeply …") before zod runs, and wraps `parseWorld` in a try/catch that maps any throw to a typed `invalid` failure.

## Regression tests
tests/client/world-file-deep.test.ts (the review repro, moved, plus: just past the limit, every shipped world still imports, jsonDepth on a 200 000-deep array).
