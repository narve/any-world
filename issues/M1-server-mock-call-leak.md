# Server keeps every /api/llm request to the "mock" preset in memory forever

- Severity: major
- Area: server/app.ts (getMock), src/llm/mock.ts
- Status: fixed

## Evidence
`MockProvider.complete` pushed every request into `this.calls`. The server builds one long-lived
MockProvider for preset "mock" (always configured), so every request body (up to 4 MB) was retained
for the life of the process. Repro (scratchpad s3.mts, 60 x 0.9 MB POSTs): heapUsed grew by 57 MB after GC.

## Fix
- `MockProviderOptions.maxCalls` (default unlimited for tests): 0 keeps nothing, N keeps the latest N
  (oldest dropped). New `callCount` counts every request regardless.
- `server/app.ts` getMock passes `maxCalls: 0`.
- `createProvider({preset:'mock'})` (client play sessions) defaults to `maxCalls: 100`.
- Same repro after the fix: 2.9 MB retained.

## Regression tests
- tests/llm/mock.test.ts "MockProvider call log bounds"
- tests/server/llm-limits.test.ts "server mock preset memory"
