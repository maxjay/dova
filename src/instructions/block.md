## Azure DevOps work: use `dova`

Work items, pull requests, and pipelines for this repo live in Azure
DevOps. `dova` wraps `az` and `git`, inferring organization, project,
and repo from the git remote — so its commands need no `--org` or
`--project`.

Use it instead of calling `az boards` / `az repos` directly. Beyond the
shorter commands, `dova` records which branch corresponds to which work
item, and raw `az` neither writes nor reads that. If `dova` is not
installed, say so rather than falling back to `az` — the fallback looks
like it worked and quietly loses the linkage.

`dova <command> --help` lists flags. Below is what `--help` cannot tell
you.

### Which command answers which question

| Question | Command |
|---|---|
| What's the state of this branch? | `dova status` |
| What does this ticket say? | `dova wi view <id>` |
| **What code changed in this PR?** | `dova summarize <pr-id>` |
| What's the discussion on this PR? | `dova pr view <pr-id>` |
| What's happened on this branch? | `dova summarize <branch>` |
| What does this whole thread say? | `dova pr comment show <pr-id> <thread-id>` |
| Why did CI fail? | `dova pipeline log` |
| Which branches are mid-work? | `dova list` |
| Anything not wrapped above | `dova api <path>` |

`dova pr view` shows metadata and comment threads but **not the diff**.
`dova summarize` is the one that reads code — it takes a PR id, a PR
url, or a branch name, and fetches the branch first if it isn't local,
so it works on a PR nobody here has checked out.

Its `Diff` section is **committed work only** — that's what a PR would
contain. Anything still in the working tree appears below it under
`Uncommitted`, and only when summarizing the branch you're on. If you
have just edited files and want them reflected in `Diff`, commit
first; don't assume an empty `Diff` means you changed nothing.

### Worked example: implement a ticket

```console
$ dova wi view 4821
#4821 Login redirects to the wrong page after sign-in
Bug · Active · assigned to Jane Doe

Area:      MyProject\Platform
Iteration: MyProject\Sprint 14

$ git checkout -b fix/4821-login-redirect   # git's job — dova never creates branches
$ dova link 4821
Branch: fix/4821-login-redirect

Linked work items:
  #4821 [Bug] Login redirects to the wrong page after sign-in (primary)

# ...implement, commit...

$ dova pr create
Created PR #612 — Fix null check in redirect handler
  https://dev.azure.com/contoso/MyProject/_git/my-repo/pullrequest/612
  Work items: #4821
```

The ticket attached because `dova link` ran first. Without it, `pr
create` falls back to `#id` references in commit messages, and with
neither the PR is created **successfully with nothing attached and no
error** — the linkage is simply missing and nothing reports it later.

### Worked example: answer review feedback

```console
$ dova status
Branch: fix/4821-login-redirect

Pull Request
  #612 Fix null check in redirect handler
  active · opened by Agent

Comment Threads
┌──────────┬─────────────────┬─────────────┬──────────────────────────────┐
│ Status   │ Location        │ Last author │ Last comment                 │
├──────────┼─────────────────┼─────────────┼──────────────────────────────┤
│ open     │ /src/auth.ts:42 │ Jane Doe    │ Can you also handle the nu.. │
└──────────┴─────────────────┴─────────────┴──────────────────────────────┘

$ dova pr comment show 612 4        # read the WHOLE thread before acting
Thread #4 on PR #612
/src/auth.ts:42
Status: active

SonarQube · 2026-08-22T10:00:00Z
  Fix this cognitive complexity issue by extracting the validation logic.

Jane Doe · 2026-08-22T10:15:00Z
  Can you also handle the null case here while you're at it?

# ...make the change, commit, push...

$ dova pr comment reply 612 4 --resolve - <<'EOF'
Extracted the validation into `validateSession()` and added the null
check — `$token` is now checked before the redirect decision.
EOF
Replied in thread #4 on PR #612.
Set thread #4 on PR #612 to "fixed".
```

The status table only ever shows the *last* comment, so `comment show`
first — the earlier comments often carry the actual request.

### Worked example: CI is red

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token (14 ms)

  Expected: "/dashboard"
  Received: "/undefined"
```

Fix the cause and push. Don't re-run hoping it passes.

### Worked example: review someone else's PR

```console
$ dova summarize 785            # no checkout, no local branch needed
Branch: feature/305-dark-mode
compared against origin/main

#305 [User Story/Active] Add dark mode (primary)

Commits (3 since origin/main)
  a1b2c3d Add theme toggle
  ...

Diff
src/theme.ts | 42 ++++++++++++++
```

### Worked example: file a bug you hit mid-task

```console
$ dova bug 'Null check missing on empty session token' --at src/auth.ts:88 --link
Created Bug #5219
  Area: MyProject\Platform
Branch: fix/4821-login-redirect

Linked work items:
  #4821 [Bug] Login redirects to the wrong page after sign-in (primary)
  #5219 [Bug] Null check missing on empty session token
```

`--at` builds a permalink to that line; `--link` attaches it to the
current branch so it rides along on the same PR.

### Common mistakes

**Reading a PR's code.** `pr view` returns metadata, not a diff.

```console
✗ dova pr view 612          # threads and status — no code
✓ dova summarize 612        # the actual diff
```

**Closing a ticket after merge.** Don't. `dova pr create` passes
`--transition-work-items`, so Azure DevOps moves linked items itself
when the PR completes.

```console
✗ az boards work-item update --id 4821 --state Resolved
✓ (nothing — it happens on completion)
```

**Setting up a ticket's branch.** `dova` never creates, names, or checks
out branches, and never changes a work item's state, assignee, or
priority. Those belong to the person and to git.

```console
✗ dova checkout 4821        # no such command, by design
✓ git checkout -b fix/4821-login && dova link 4821
```

**Free text with backticks, `$`, or quotes.** The shell mangles it
before `dova` sees it — in bash `"...$total..."` expands to nothing and
backticks inside double quotes *execute*.

```console
✗ dova pr comment 612 "Fixed the $count check in `auth.ts`"
✓ dova pr comment 612 - <<'EOF'
Fixed the $count check in `auth.ts`
EOF
```

Every command taking free text accepts `-` for stdin (`--title -` for
the flag form). Short titles are fine inline **single**-quoted; use
stdin when the text has an apostrophe or runs long.

**Retrying a command that asked a question.** With no terminal, `dova`
never prompts — it fails immediately, naming the flag that answers it
and listing the real values. Read the error and re-run with that flag.

```console
$ dova bug 'Something broke'
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.
  Available: Platform, Payments

✓ dova bug 'Something broke' --team Platform
```

`--team`, `--area`, `--iteration`, and `--like <id>` (copy area and
iteration from an existing ticket) are the escape hatches; `--area` and
`--iteration` together skip team resolution entirely.

### Parsing output

Add `--json` (optionally `--json <fields>`, plus `--jq <expr>`) to any
read command when parsing — the human output is for humans and its
shape is not a contract. Exit codes distinguish causes: `1` bad input,
`2` not found, `3` `az` missing or logged out, `4` an `az`/`git` call
failed.
