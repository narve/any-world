# Archive

Historical records of how the single-player game (v1, milestones M0–M5) was built. They are kept as
they were written and are not updated as the code changes, so paths, test counts, key maps and
screenshots here may be out of date. For the current state, read the [README](../../README.md),
[DESIGN.md](../../DESIGN.md), [PLAN.md](../../PLAN.md), [HOSTING.md](../HOSTING.md) and
[the multiplayer plan](../MULTIPLAYER-PLAN.md).

- [RETROSPECTIVE.md](RETROSPECTIVE.md): what worked and what did not in the autonomous v1 build
  (2026-10-25).
- [STATS.md](STATS.md): agents, wall time and tokens per milestone, M0–M5.
- [progress/](progress/): the milestone notes [M1](progress/M1.md), [M2](progress/M2.md),
  [M3](progress/M3.md), [M4](progress/M4.md) and [M5](progress/M5.md) (the v1 Definition-of-Done table),
  each with its screenshot folder. `progress/M2/` also holds the M2 bot playtest facts (`*.json`) and
  `sim-report.md`.

Still in use elsewhere, so not archived: `BUILD_LOG.md` (the running log), `issues/` (cited from code
comments), `docs/playtest/` (cited from code comments) and the multiplayer notes in `docs/progress/`.

Some e2e specs still write their screenshots into `progress/M2`–`M5` when run with `SHOTS_TO_DOCS=1`
(README → Development). Without it they go to `test-results/shots/`, which is what you want unless you
mean to replace these records.

`progress/M5-review-local/` is git-ignored: the 1158 M5 review screenshots (~400 MB) pruned from git
before the first push stay only on the machine that made them. M5 screenshots named in `BUILD_LOG.md`
or an issue file but missing from `progress/M5/` are among them.
