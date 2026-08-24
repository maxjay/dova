## Azure DevOps work: use `dova`

Work items, pull requests, and pipelines for this repo live in Azure
DevOps. `dova` wraps `az` and `git`, inferring organization, project,
and repo from the git remote — so its commands need no `--org` or
`--project`.

Use it instead of calling `az boards` / `az repos` directly. Beyond the
shorter commands, `dova` records which branch corresponds to which
work item, and raw `az` neither writes nor reads that. If `dova` is not
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
| What does this whole comment thread say? | `dova pr comment show <pr-id> <thread-id>` |
| Why did CI fail? | `dova pipeline log` |
| Which branches are mid-work? | `dova list` |
| Anything not wrapped above | `dova api <path>` |

`dova pr view` shows metadata and comment threads but **not the diff**.
`dova summarize` is the one that reads code — it takes a PR id, a PR
url, or a branch name, and fetches the branch first if it isn't local,
so it works on a PR nobody here has checked out.

### The ordering that matters

Run `dova link <id>` before `dova pr create`.

`pr create` resolves work items from `--work-items`, else the ids
`dova link` recorded, else `#id` references in the branch's commit
messages. If none of those exist the PR is created successfully with
**no work item attached and no error** — the linkage is simply missing,
and nothing will point that out later.

```sh
git checkout -b fix/4821-login-redirect   # git's job — dova does not create branches
dova link 4821
# ...implement...
dova pr create                            # the ticket attaches automatically
```

`dova unlink <id>` (or `--all`) undoes a bad link.

### What `dova` deliberately will not do

`dova` never creates, names, or checks out branches, and never changes
a work item's state, assignee, or priority. Those belong to the person
and to git. Do not route around this with raw `az`:

- **Don't** run `az boards work-item update --state ...` to "close" a
  ticket after merging. Azure DevOps transitions linked work items
  itself when the PR completes — `dova pr create` passes
  `--transition-work-items` for exactly this.
- **Don't** script `git checkout` as part of "starting" a ticket.
  Create the branch however you normally would, then `dova link`.

### It cannot ask you anything

With no terminal attached, `dova` never prompts — it fails immediately
instead, naming the flag that would have answered it and listing the
real values:

```
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.
  Available: Platform, Payments
```

Read the error and re-run with that flag. `--team`, `--area`,
`--iteration`, and `--like <id>` (copy area/iteration from an existing
ticket) are the escape hatches; `--area` and `--iteration` together
skip team resolution entirely.

### Free text goes on stdin

The shell mangles text before `dova` ever sees it: in bash
`"...$total..."` expands to nothing, and backticks inside double quotes
*execute*. Pipe anything containing backticks, `$`, or quotes — it
arrives untouched, and nothing needs escaping:

```sh
dova pr comment 612 - <<'EOF'
Fixed in `auth.ts` — the $token check was inverted.
EOF
```

Every command taking free text accepts `-` for stdin (`--title -` for
the flag form). Short titles are fine inline **single**-quoted; use
stdin when the text contains an apostrophe or runs long.

### Reading output

Add `--json` (optionally `--json <fields>`, and `--jq <expr>`) to any
read command when parsing — the human output is for humans and its
shape is not a contract. Exit codes distinguish causes: `1` bad input,
`2` not found, `3` `az` missing or logged out, `4` an `az`/`git` call
failed.
