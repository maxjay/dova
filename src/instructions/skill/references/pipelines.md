# Pipelines

## Which runs count as this branch's

`dova status` and every `dova pipeline` command show runs for **this
branch's ref only**. Runs on other branches are filtered out, so an
empty list means this branch has never been built — not that dova
failed to look.

Where the branch has an open PR, its **build-validation runs are
included too, and listed first**. Azure DevOps builds those against a
temporary merge commit, so they report `refs/pull/<id>/merge` rather
than the branch's own ref. They are the runs that gate the merge, so
a green branch build with a failing validation run means the PR is
blocked. Read the top row, not the first green one.

## Why a run failed

`dova pipeline log` prints the failing task's own log, not just the
verdict. With no run id it takes the most recent run for this branch.

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token (14 ms)

  Expected: "/dashboard"
  Received: "/undefined"
```

The last 200 lines, from the first failed task. Widen only when that
isn't enough:

- `--full` — the whole log rather than the tail
- `--all` — every failed task, not just the first
- `--task <name>` — one named task, failed or not
- `--branch <branch>` — a different branch's latest run
- a run id as the argument — that exact run

Fix what it reports. **Never re-run a pipeline hoping it passes.** A
failure that reproduces is a failure, and a re-run spends minutes to
learn nothing.

## Waiting

`dova pipeline watch` polls until the run finishes and exits non-zero
if it failed, so it can gate a following step. With no run id it
watches this branch's most recent run.

## Listing

`dova pipeline status` lists recent runs, `--branch` for another
branch. `dova status` already includes this branch's last three
alongside the PR, work items and comment threads — prefer it when you
want more than CI, since it is one command rather than several, and
each `az` call costs seconds.
