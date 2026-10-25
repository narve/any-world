# Build stats (best effort)

| Phase | Workflows | Agents | Wall time | Notes |
|---|---|---|---|---|
| M0 contracts | 0 | 0 (orchestrator only) | ~1h incl. design talk | |
| M1 foundation | 1 (wf_8e6f11cd-5af) | 27 (24 ok, 3 failed with API 529 Overloaded: integrator + 2 round-1 reviewers) | ~2h43m | 4.39M subagent tokens, 1144 tool calls; 3 review/fix rounds; 545 unit + 25 e2e tests at gate |
| M2 systems | 1 (wf_91f4dc8e-103) | 30 (0 failed; engine builder + integrator declined their tasks after misreading a status question; the fixers and the gate did that work) | ~4h08m | 4.58M subagent tokens, 1604 tool calls; 3 review/fix rounds; 909 unit + 86 e2e tests at gate |
| M3 AI content | 1 (wf_7da8e666-275, one workflow for M3–M5; phases "M3 Build", "M3 Content", "M3 Gate") | 21 (0 failed): 5 builders (engine, client, llm, renderer, integrator), 15 content agents (prompt library + 14 world authors acting as the LLM provider), 1 gate | ~3h34m (12:23–15:57 UTC) | 1.71M output, 10.41M cache-write, 277.7M cache-read tokens; 1801 tool calls. Gate: vitest green (new prompts/start-languages/m3-gate/goal-labels suites), 121/121 Playwright, 18/18 worlds valid, sim 3600 runs 0 crash/stuck |
| M4 polish & modes | same workflow (phases "M4 Build", "M4 Gate") | 5 (0 failed): audio, i18n (bokmål), mobile, app shell, gate | ~6h27m (15:57–22:23 UTC), of which ~3h20m was the gate agent stalled on a cut-off response | 0.55M output, 5.70M cache-write, 104.5M cache-read tokens; 598 tool calls. Gate: 1448 vitest (104 files), Playwright 140 tests (114 first run + 26/26 rerun of the two failing specs), nb playthrough 3/3, sim 800 runs 0 crash/stuck |
| M5 review & fix | same workflow (phases "Review", "Fix", "Gate") | 3 review rounds × 6 reviewers (adversarial code, balance/robustness, DoD audit, Norwegian, desktop playtest, mobile playtest), fixers per round (round 1: 9), 1 gate | ~10h (22:23 UTC → gate commit ~08:40 UTC next day) | Gate: tsc clean, 1810 vitest (145 files), 182 Playwright (all pass after rerunning env failures with the API server up) + 13 final-screenshot tests + nb playthrough 3/3, validate-worlds 20/20, sim 4000 runs 0 crash (2 cautious-bot loops), new-player gate 20/20. Token totals for M5: orchestrator to add |

Token figures for M3–M5 are summed from the subagent transcripts (usage per assistant message, by phase), so
they split output, cache-write and cache-read tokens. The M1/M2 rows use the workflow tool's single
`totalTokens` figure, which is counted differently; compare within a row style only.
