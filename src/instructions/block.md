## Azure DevOps: use `dova`

Work items, pull requests and pipelines for this repo are in Azure
DevOps. Use `dova` for all of them. Never call `az boards` or `az repos`
directly: `dova` infers org, project and repo from the git remote, and
records the branch-to-ticket link that raw `az` can neither read nor
write.

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
| File a bug | `dova bug '<title>' --at <file>:<line> --link` |
| Anything else | `dova api <path>` |

`dova view` replaces `dova wi view` and `dova pr view <id>` — use it
unless you need a PR's comment threads.

Long descriptions truncate. Pass `--full` to `view` or `summarize` for
the rest. Never go to the browser for it.

### Start work on a ticket

```console
$ dova view 4821
#4821 Login redirects to the wrong page after sign-in
User Story · Ready · unassigned

Area:      MyProject\Platform
Iteration: MyProject\Sprint 14

Description
Users are sent to /undefined after sign-in.

Acceptance Criteria
- Redirect resolves to /dashboard for a valid token
- Invalid tokens return to /login with an error

$ git checkout -b fix/4821-login-redirect   # git's job — dova never creates branches
$ dova link 4821
Branch: fix/4821-login-redirect

Linked work items:
  #4821 [User Story] Login redirects to the wrong page (primary)

# ...implement, commit...

$ dova pr create
Created PR #612 — Fix null check in redirect handler
  Work items: #4821
```

Run `dova link` before `dova pr create`, always. Without it `pr create`
falls back to `#id` references in commit messages; with neither, the PR
opens with nothing attached and no error, and nothing reports it later.

Working several related tickets on one branch: `dova link 4821 5219
5220`. The first id is primary. Correct a bad link with `dova unlink
<id>`, or `--all` to clear the branch. Add `--draft` to `pr create`
when the work isn't ready for review.

### Answer review feedback

```console
$ dova status
Branch: fix/4821-login-redirect

Pull Request
  #612 Fix null check in redirect handler · active

Comment Threads
  #4  open  /src/auth.ts:42  Jane Doe  "Can you also handle the nu.."

$ dova pr comment show 612 4      # read the whole thread, not the preview
Thread #4 on PR #612 · /src/auth.ts:42 · active

SonarQube · 2026-08-22T10:00:00Z
  Extract the validation logic — cognitive complexity.
Jane Doe · 2026-08-22T10:15:00Z
  Can you also handle the null case while you're here?

# ...fix, commit, push...

$ dova pr comment reply 612 4 --resolve - <<'EOF'
Extracted into `validateSession()` and added the null check.
EOF
Replied in thread #4 on PR #612.
Set thread #4 on PR #612 to "fixed".
```

Read the whole thread before replying. `status` shows only the last
comment; the actual request is usually earlier. Reply and resolve in
one call. To close a thread without replying: `dova pr comment resolve
612 4`.

### Review someone else's PR

```console
$ dova summarize 785
Branch: feature/305-dark-mode
compared against origin/main

#305 [User Story/Active] Add dark mode (primary)
Description: Users on shared machines want a dark theme.

Commits (3 since origin/main)
  a1b2c3d Add theme toggle

Diff
src/theme.ts | 42 ++++++++++++++
```

It fetches the branch itself. Never `git checkout` to read a PR.

### Fix red CI

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token (14 ms)

  Expected: "/dashboard"
  Received: "/undefined"
```

Fix what it reports. Never re-run hoping it passes. `dova pipeline
watch` blocks until a run finishes and exits non-zero on failure.

### Rules

**Use `dova summarize` for code, not `dova pr view`.**

```console
✗ dova pr view 612          # threads and status — no code
✓ dova summarize 612        # the diff, fetched if not local
```

**Never re-read what you already have.** `summarize` prints every
linked ticket's body under its title. Choose human or `--json` before
you run, never after — a second call re-pays the whole `az` cost for
output already on screen.

```console
✗ dova summarize && dova view 3917455
✗ dova view 3917455 && dova view 3917455 --json
✓ dova summarize            # you now have every linked ticket
```

**`summarize`'s `Diff` is committed work only** — that is what a PR
will contain. Uncommitted work appears below it under `Uncommitted`,
and only for the branch you are on. An empty `Diff` does not mean you
changed nothing; commit to move edits into it.

**Never change a ticket's state, assignee or priority.** `dova pr
create` passes `--transition-work-items`, so Azure DevOps transitions
linked items itself on completion.

```console
✗ az boards work-item update --id 4821 --state Resolved
✓ (nothing — it happens automatically)
```

**Never create, name or check out branches with `dova`.** It has no
such command, by design. Use git, then `dova link`.

```console
✗ dova checkout 4821
✓ git checkout -b fix/4821-login && dova link 4821
```

**Pipe free text; never inline it with double quotes.** The shell
mangles it before `dova` sees it — in bash `"...$total..."` expands to
nothing and backticks inside double quotes *execute*.

```console
✗ dova pr comment 612 "Fixed the $count check in `auth.ts`"
✓ dova pr comment 612 - <<'EOF'
Fixed the $count check in `auth.ts`
EOF
```

Every command taking free text accepts `-` for stdin (`--title -` for
the flag form). Single-quote short titles; pipe anything with an
apostrophe.

**Read the error and re-run with the flag it names.** Without a
terminal `dova` never prompts — it fails immediately with the answer.

```console
$ dova bug 'Something broke'
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.
  Available: Platform, Payments

✓ dova bug 'Something broke' --team Platform
```

`--team`, `--area`, `--iteration` and `--like <id>` (copy area and
iteration from an existing ticket) are the escape hatches. `--area` and
`--iteration` together skip team resolution entirely.

### Output

`--json` (optionally `--json <fields>`, plus `--jq <expr>`) on any read
command. Human output is for humans and its shape is not a contract.
Exit codes: `1` bad input, `2` not found, `3` `az` missing or logged
out, `4` an `az`/`git` call failed.
