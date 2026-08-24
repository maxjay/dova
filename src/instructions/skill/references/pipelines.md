# Pipelines

## Why a run failed

`dova pipeline log` prints the failing task's own log, not just the
verdict. With no run id it takes the most recent run for the current
branch.

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token (14 ms)

  Expected: "/dashboard"
  Received: "/undefined"
```

Fix what it reports. Never re-run a pipeline hoping it passes — a
failure that reproduces is a failure, and re-running spends minutes to
learn nothing.

## Waiting

`dova pipeline watch` polls a run until it finishes and exits non-zero
if it failed, so it can gate a subsequent step. With no run id it
watches the most recent run for the current branch.

## Recent runs

`dova pipeline status` lists recent runs for a branch. `dova status`
already includes the last three for the current branch, so prefer that
when you also want the PR and work items — one command, one `az` call
instead of several.
