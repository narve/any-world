# DoD #10: RETROSPECTIVE.md missing, no M3/M4 rows in STATS.md, almost no M3/M4 issue files

- Severity: major
- Area: documentation (DESIGN §9, DoD §10 item 10)
- Status: fixed (RETROSPECTIVE.md written during M5 review round 1; the M5 gate should add the final M5 numbers)
- Source: M5 DoD audit round 1

## Evidence
`ls RETROSPECTIVE.md`: No such file, although README.md links it. STATS.md stopped after the M2 row.
issues/ had 31 M1 files, 39 M2 files, 1 M3 file and 0 M4 files, while BUILD_LOG.md has 19 [M3]/[M4] lines
that mention fixes or bugs.

## Fix
- RETROSPECTIVE.md: what worked, what did not, numbers per milestone, and a checklist of what a human still has
  to check (real-device touch and frame rate, iOS audio unlock and safe areas, the first live LLM run, …).
- STATS.md: rows for M3, M4 and M5 (so far), measured from the workflow's subagent transcripts (agents, wall
  time, tool calls, output / cache-write / cache-read tokens) plus the test counts at each gate.
- issues/: 11 M3 files and 12 M4 files back-filled from the BUILD_LOG fix entries, each with evidence, fix and
  regression test. M5 review findings are recorded by the fixer that owns each fix (issues/M5-*.md).
- README.md links RETROSPECTIVE.md as a real link.

## Regression tests
Documentation only.
