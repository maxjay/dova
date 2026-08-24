## Azure DevOps work: use `dova`

Work items, pull requests, and pipelines live in Azure DevOps. Use
`dova` for them rather than calling `az boards` / `az repos` directly:
it infers organization, project, and repo from the git remote, so its
commands need no `--org` or `--project` — and it records which branch
corresponds to which work item, which raw `az` neither writes nor reads.

If `dova` is not installed, say so rather than falling back to `az` —
the fallback looks like it worked and quietly loses the linkage.

`dova <command> --help` lists flags. Below is what `--help` can't tell
you.

### Which command answers which question

| Question | Command |
|---|---|
| What's the state of this branch? | `dova status` |
| What does this ticket say? | `dova wi view <id>` |
| **What code changed in this PR?** | `dova summarize <pr-id>` |
| What's the discussion on this PR? | `dova pr view <pr-id>` |
| What does this whole thread say? | `dova pr comment show <pr-id> <thread-id>` |
| Why did CI fail? | `dova pipeline log` |
| Which branches are mid-work? | `dova list` |

### Implementing a ticket

```console
$ dova wi view 4821
#4821 Login redirects to the wrong page after sign-in
Bug · Active · assigned to Jane Doe

$ git checkout -b fix/4821-login   # git's job — dova never creates branches
$ dova link 4821
Branch: fix/4821-login

Linked work items:
  #4821 [Bug] Login redirects to the wrong page after sign-in (primary)

# ...implement, commit...

$ dova pr create
Created PR #612 — Fix null check in redirect handler
  Work items: #4821
```

The ticket attached because `dova link` ran first. Without it, `pr
create` falls back to `#id` references in commit messages; with
neither, the PR is created **successfully with nothing attached and no
error**.

### Answering review feedback

```console
$ dova status                     # lists open threads with their ids
  ...
  Comment Threads
    #4  open  /src/auth.ts:42  Jane Doe  "Can you also handle the nu.."

$ dova pr comment show 612 4      # read the WHOLE thread first
Thread #4 on PR #612 · /src/auth.ts:42 · active

SonarQube · 2026-08-22T10:00:00Z
  Fix this cognitive complexity issue by extracting the validation logic.
Jane Doe · 2026-08-22T10:15:00Z
  Can you also handle the null case here while you're at it?

# ...fix, commit, push...

$ dova pr comment reply 612 4 --resolve - <<'EOF'
Extracted into `validateSession()` and added the null check.
EOF
Replied in thread #4 on PR #612.
Set thread #4 on PR #612 to "fixed".
```

The status table only shows the *last* comment — the earlier ones
usually carry the actual request, so `comment show` before acting.

### Red CI, and reviewing someone else's PR

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token
  Expected: "/dashboard"  Received: "/undefined"

$ dova summarize 785        # no checkout, no local branch needed
Branch: feature/305-dark-mode
compared against origin/main

#305 [User Story/Active] Add dark mode (primary)

Diff
src/theme.ts | 42 ++++++++++++++
```

Fix what `pipeline log` reports. Don't re-run hoping it passes.

### Filing a bug mid-task

```console
$ dova bug 'Null check missing on empty session token' --at src/auth.ts:88 --link
Created Bug #5219
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
✓ dova summarize 612        # the actual diff, fetched if not local
```

**Closing a ticket after merge.** Don't. `dova pr create` passes
`--transition-work-items`, so Azure DevOps moves linked items itself on
completion.

```console
✗ az boards work-item update --id 4821 --state Resolved
✓ (nothing — it happens automatically)
```

**Branch or ticket lifecycle.** `dova` never creates, names, or checks
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
the flag form). Short titles are fine inline **single**-quoted.

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

`--team`, `--area`, `--iteration`, and `--like <id>` are the escape
hatches; `--area` and `--iteration` together skip team resolution.

### Parsing output

Add `--json` (plus `--jq <expr>`) to any read command when parsing — the
human output is not a contract. Exit codes: `1` bad input, `2` not
found, `3` `az` missing or logged out, `4` an `az`/`git` call failed.
