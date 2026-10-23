# Build log

Chronological. Format: `YYYY-MM-DD [milestone/agent] note`.

- 2026-10-23 [M0/orchestrator] Design agreed interactively (DESIGN.md). Build runs in bypass-permissions mode with workflows.
- 2026-10-23 [M0/orchestrator] Pinned deps: three 0.186.1, zod 4.6.7, vite 8.3.5, vitest 5.0.5, TS 5.9.3 (chose 5.x over 7.x for tooling compatibility).
- 2026-10-23 [M0/orchestrator] Headless Chromium has no WebGL in this sandbox; headed Chromium under xvfb works. Installed system deps with `playwright install-deps`. E2E runs via `xvfb-run`.
- 2026-10-23 [M0/orchestrator] World Spec JSON Schema is ~113k chars, so LLM prompts must use a condensed schema description.
