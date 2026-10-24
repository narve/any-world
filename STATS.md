# Build stats (best effort)

| Phase | Workflows | Agents | Wall time | Notes |
|---|---|---|---|---|
| M0 contracts | 0 | 0 (orchestrator only) | ~1h incl. design talk | |
| M1 foundation | 1 (wf_8e6f11cd-5af) | 27 (24 ok, 3 failed with API 529 Overloaded: integrator + 2 round-1 reviewers) | ~2h43m | 4.39M subagent tokens, 1144 tool calls; 3 review/fix rounds; 545 unit + 25 e2e tests at gate |
| M2 systems | 1 (wf_91f4dc8e-103) | 30 (0 failed; engine builder + integrator declined their tasks after misreading a status question; the fixers and the gate did that work) | ~4h08m | 4.58M subagent tokens, 1604 tool calls; 3 review/fix rounds; 909 unit + 86 e2e tests at gate |
