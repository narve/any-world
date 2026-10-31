# DoD #1: backend mode never tested a prompt and "Surprise me" separately, and `npm start` was never tested

- Severity: minor
- Area: e2e (e2e/modes.spec.ts)
- Status: fixed
- Source: M5 DoD audit round 1

## Evidence
DoD #1 asks that in both modes a run can be started "with a prompt or with surprise me, or in demo mode". The
backend group of e2e/modes.spec.ts had one generation case plus a demo world. No e2e started `npm start`
(the production server serving dist/client); docs/archive/progress/M4.md listed this as a known issue.

## Fix
e2e/modes.spec.ts now has:
- backend (server/dev.ts): "Surprise me" through /api/llm (the existing case, renamed), and a new case that types
  a prompt, creates the world through /api/llm, and checks that the prompt reached the fake model;
- a "production server (npm start)" group: `vite build` into a scratch folder (test-results/modes-prod-client,
  so a parallel build into dist/client cannot break it), then `npm start` with PORT, HOST, STATIC_DIR and the fake
  OLLAMA endpoint. It checks that / serves the client, plays a demo world for a few turns, and creates a world with
  "Surprise me" through the backend.
The port is MODES_PORT (default 5193), so parallel agents can run the spec side by side.

## Regression tests
e2e/modes.spec.ts: 12/12 passed (`MODES_PORT=5402 xvfb-run -a npx playwright test e2e/modes.spec.ts`).
