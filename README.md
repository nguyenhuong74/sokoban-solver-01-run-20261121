# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nguyenhuong74/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nguyenhuong74/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's generated levels. Each level is
a 1-wide hallway with 1–4 rooms off it, and a box pushed out of a room can
never come back, so the rooms are independent subproblems: the solver splits
the level into rooms, solves each room with a push-based breadth-first
search (the first solved state found is push-optimal for that room), and
stitches the room solutions together with player walks along the hallway.
That reaches the level optimum P* — the sum of the rooms' optima — whenever
every room search finishes inside its deterministic node budget.

The search prunes two deadlocks that can never lead to a solution: boxes on
dead squares (no push from there can ever reach a goal, found by pulling
boxes backwards from the goals) and frozen 2×2 blocks of walls and boxes.
It budgets by node count only — no wall clock, no randomness — so two runs
on the same input produce byte-identical output. Every solution is replayed
on its level before it is written; anything unverified falls back to the
empty answer rather than risk an illegal move.

On the practice set it solves all 5 instances at P* (13/16/29/47/60 pushes),
score 1,000,000, in a few seconds.

## Run it

```sh
node main.ts
```

`main.ts` reads every instance from `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` (creating each output directory itself).
Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output`. Node 22 or later, no dependencies, no network.

## Grade it locally

```sh
cd <kit>
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
