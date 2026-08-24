## Azure DevOps: use `dova`

Work items, pull requests and pipelines are in Azure DevOps. Use `dova`
for all of them. Never call `az boards` or `az repos` directly: `dova`
infers org, project and repo from the git remote, and records the
branch-to-ticket link that raw `az` can neither read nor write.

If `dova` is not installed, say so and stop. Do not fall back to `az`.

Run `dova <command> --help` for flags. Below is what `--help` omits.

### Pick the command

| Need | Run |
|---|---|
| State of this branch | `dova status` |
| Read a ticket or a PR | `dova view <id>` — auto-detects which |
| A PR's code | `dova summarize <pr-id>` |
| A PR's discussion | `dova pr view <pr-id>` |
| One thread in full | `dova pr comment show <pr-id> <thread-id>` |
| Why CI failed | `dova pipeline log` |
| Wait for CI | `dova pipeline watch` |
| Catch up on a branch | `dova summarize <branch>` |
| Branches mid-work | `dova list` |
| Find tickets | `dova wi search <query>` |
| Anything else | `dova api <path>` |

`dova view` replaces `dova wi view` and `dova pr view <id>` — use it
unless you need a PR's comment threads.

Long descriptions truncate. Pass `--full` to `view` or `summarize` to
get the rest. Do not go to the browser for it.

### Start work on a ticket

```console
$ dova view 4821
#4821 Login redirects to the wrong page after sign-in
User Story · Ready · unassigned

Description
Users are sent to /undefined after sign-in.

Acceptance Criteria
- Redirect resolves to /dashboard for a valid token

$ git checkout -b fix/4821-login   # git's job — dova never creates branches
$ dova link 4821
$ dova pr create                   # ticket attaches automatically
Created PR #612 — Fix null check in redirect handler
  Work items: #4821
```

Run `dova link` before `dova pr create`, always. Without it `pr create`
falls back to `#id` in commit messages; with neither, the PR opens with
nothing attached and no error. Use `dova unlink <id>` to correct a bad
link.

Working several related tickets on one branch: `dova link 4821 5219
5220`. The first is primary. Add `--draft` to `pr create` when the work
isn't ready for review.

### Answer review feedback

```console
$ dova status
  Comment Threads
    #4  open  /src/auth.ts:42  Jane Doe  "Can you also handle the nu.."

$ dova pr comment show 612 4      # read the whole thread, not the preview
SonarQube · 10:00Z
  Extract the validation logic — cognitive complexity.
Jane Doe · 10:15Z
  Can you also handle the null case while you're here?

$ dova pr comment reply 612 4 --resolve - <<'EOF'
Extracted into `validateSession()` and added the null check.
EOF
```

Read the whole thread before replying. `status` shows only the last
comment; the request is usually earlier. Reply and resolve in one call.
To close a thread without replying: `dova pr comment resolve 612 4`.

Review a PR you never checked out with `dova summarize <pr-id>` — it
fetches the branch itself. Never `git checkout` to read one.

### Fix red CI

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token
```

Fix what it reports. Never re-run hoping it passes.

### Rules

**Use `dova summarize` for code, not `dova pr view`.**

```console
✗ dova pr view 612          # threads and status — no code
✓ dova summarize 612        # the diff, fetched if not local
```

**Never re-read what you already have.** `summarize` prints every
linked ticket's body. Choose human or `--json` before you run, never
after — a second call re-pays the whole `az` cost.

```console
✗ dova summarize && dova view 3917455
✗ dova view 3917455 && dova view 3917455 --json
```

**`summarize`'s `Diff` is committed work only.** Uncommitted work
appears below under `Uncommitted`. An empty `Diff` does not mean you
changed nothing.

**Never change ticket state.** `dova pr create` passes
`--transition-work-items`; Azure DevOps transitions linked items on
completion.

```console
✗ az boards work-item update --id 4821 --state Resolved
```

**Never create or check out branches with `dova`.** It has no such
command, by design. Use git, then `dova link`.

**Pipe free text; never inline it with double quotes.** In bash
`"...$total..."` expands to nothing and backticks *execute*.

```console
✗ dova pr comment 612 "Fixed the $count check in `auth.ts`"
✓ dova pr comment 612 - <<'EOF'
Fixed the $count check in `auth.ts`
EOF
```

Every free-text command takes `-` for stdin (`--title -` for flags).
Single-quote short titles.

**Read the error and re-run with the flag it names.** `dova` never
prompts without a terminal; it fails with the answer.

```console
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.  Available: Platform, Payments
```

`--team`, `--area`, `--iteration`, `--like <id>` are the escape hatches.

**File bugs as you hit them.** `dova bug 'Null check missing' --at
src/auth.ts:88 --link` permalinks the line and attaches it to this
branch.

### Output

`--json` (with `--jq <expr>`) on any read command. Human output is not
a contract. Exit codes: `1` bad input, `2` not found, `3` `az` missing
or logged out, `4` an `az`/`git` call failed.
