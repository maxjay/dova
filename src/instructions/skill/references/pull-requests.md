# Pull requests

## Opening one

Run `dova link <id>` before `dova pr create`. Always.

```console
$ dova pr create
Created PR #612 — Fix null check in redirect handler
  https://dev.azure.com/contoso/MyProject/_git/my-repo/pullrequest/612
  Work items: #4821, #5219
```

Work items resolve in this order:

1. `--work-items <ids...>` if passed
2. the ids `dova link` recorded for this branch
3. `#id` references in the branch's commit messages

With none of those the PR is created **successfully, with nothing
attached and no error**. Nothing reports it later. That is the failure
this ordering exists to prevent.

Title defaults to the last commit subject. `--draft` opens it as a
draft. `--title -` reads the title from stdin.

Do not close tickets after merging. `pr create` passes
`--transition-work-items true`, so Azure DevOps transitions linked
items itself when the PR completes.

## Reading the code

`dova summarize` reads code. `dova pr view` does not — it returns
metadata and comment threads.

```console
$ dova summarize 612
Branch: feature/305-dark-mode
compared against origin/main

#305 [User Story/Active] Add dark mode (primary)
Description: Users on shared machines want a dark theme.

Commits (3 since origin/main)
  a1b2c3d Add theme toggle

Diff
src/theme.ts | 42 ++++++++++++++
```

It takes a PR id, a PR url, or a branch name, and with no argument uses
the current branch. It fetches the branch if it is not local, so it
works on a PR nobody here has checked out — never `git checkout` to
read one.

`--full` prints the whole patch and full commit messages instead of the
stat.

`Diff` is **committed work only** — what the PR will contain.
Uncommitted work appears separately under `Uncommitted`, and only when
summarizing the branch you are on. An empty `Diff` does not mean you
changed nothing; commit to move edits into it.

`summarize` already prints every linked ticket's body. Do not follow it
with `dova view` on the same ids.

## Answering review threads

```console
$ dova status
Branch: fix/4821-login-redirect

Pull Request
  #612 Fix null check in redirect handler · active

Comment Threads
  #4  open  /src/auth.ts:42  Jane Doe  "Can you also handle the nu.."
```

The table shows only the **last** comment in each thread. The actual
request is usually earlier, so read the whole thread first:

```console
$ dova pr comment show 612 4
Thread #4 on PR #612 · /src/auth.ts:42 · active

SonarQube · 2026-08-22T10:00:00Z
  Extract the validation logic — cognitive complexity.
Jane Doe · 2026-08-22T10:15:00Z
  Can you also handle the null case while you're here?
```

A thread anchored to a line carries its file and line; a general PR
comment does not.

Fix the code, commit, push, then reply and resolve in one call:

```console
$ dova pr comment reply 612 4 --resolve - <<'EOF'
Extracted into `validateSession()` and added the null check.
EOF
Replied in thread #4 on PR #612.
Set thread #4 on PR #612 to "fixed".
```

`--resolve` takes an optional status: `resolved` (the default, sent as
the API's `fixed`), `active`, `won't fix`, `closed`, `pending`.

To change a status without replying: `dova pr comment resolve 612 4`.
To start a new thread: `dova pr comment 612 <text>`.

Reply text nearly always contains backticks or `$` — pipe it. See
`references/automation.md`.
