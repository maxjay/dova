## Azure DevOps: use `dova`

Never call `az boards` or `az repos`. Use `dova` — it infers org,
project and repo from the git remote and records the branch-to-ticket
link. If `dova` is not installed, stop and say so.

`dova <command> --help` lists flags.

### Commands

| Need | Run |
|---|---|
| Read a ticket or PR | `dova view <id>` |
| A PR's code | `dova summarize <pr-id>` |
| What a file changed | `dova summarize --files <path>` |
| This branch's state | `dova status` |
| A PR's threads | `dova pr view <pr-id>` |
| One thread in full | `dova pr comment show <pr-id> <thread-id>` |
| Catch up on a branch | `dova summarize <branch>` |
| Find tickets | `dova wi search <query>` |
| Why CI failed | `dova pipeline log` |
| Anything else | `dova api <path>` |

Add `--full` to `view` when text is truncated. `summarize`'s `Diff` is
a stat — for actual code, pass `--files <path...>`, not `--full`.

Depth lives in `.agents/skills/dova/references/` (or
`~/.agents/skills/dova/references/`). Open `work-items.md`,
`pull-requests.md`, `automation.md` or `pipelines.md` when working on
that area — never all of them.

### Start work

```console
$ dova view 4821
#4821 Login redirects to the wrong page after sign-in
User Story · Ready · unassigned

Description
Users are sent to /undefined after sign-in.

Acceptance Criteria
- Redirect resolves to /dashboard for a valid token

$ git checkout -b fix/4821-login
$ dova link 4821
$ dova pr create
Created PR #612 — Fix null check in redirect handler
  Work items: #4821
```

`dova link` before `dova pr create`. Always. Without it the PR opens
with no ticket attached and no error.

`dova link 4821 5219` links several; the first is primary. `dova unlink
<id>` corrects it. `dova pr create --draft` for work in progress.

### Answer review feedback

```console
$ dova status
$ dova pr comment show 612 4
$ dova pr comment reply 612 4 --resolve - <<'EOF'
Extracted into `validateSession()` and added the null check.
EOF
```

Read the whole thread first. `status` shows only the last comment; the
request is usually earlier.

### Never

- **Never** use `dova pr view` for code. Use `dova summarize`.
- **Never** re-read a ticket `summarize` already printed. It prints
  every linked ticket's body.
- **Never** re-run a command to add `--json`. Choose the format first.
- **Never** run `az boards work-item update`. `dova pr create` passes
  `--transition-work-items`; state changes on completion.
- **Never** create, name or check out a branch with `dova`. Use git,
  then `dova link`.
- **Never** `git checkout` to read a PR. `dova summarize <pr-id>`
  fetches it.
- **Never** re-run a failed pipeline hoping it passes. Fix what `dova
  pipeline log` reports.

### Free text

**Anything with a newline goes on stdin.** Passed as an argument it is
mangled: bash expands `$var` and *executes* backticks, and on Windows a
multi-line argument arrives empty or cut at the first line.

bash/zsh — quote the delimiter:

```console
✗ dova pr comment 612 "Fixed the $count check in `auth.ts`"
✓ dova pr comment 612 - <<'EOF'
Fixed the $count check in `auth.ts`
EOF
```

PowerShell — no heredocs (`<<` is a parse error). Single-quoted
here-string only; `@"` expands `$var` and eats backticks:

```powershell
@'
Fixed the $count check in `auth.ts`
'@ | dova pr comment 612 -
```

Every free-text command takes `-` for stdin; `--title -`,
`--description -` for flags. Single-quote short one-line titles.

### Errors

`dova` never prompts without a terminal. It fails naming the flag that
answers it. Re-run with that flag.

```console
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.  Available: Platform, Payments
```

`--team`, `--area`, `--iteration`, `--like <id>` are the escape hatches.

### Output

`--json` (with `--jq <expr>`) on any read command; human output is not
a contract. `summarize`'s `Diff` is committed work only — uncommitted
appears under `Uncommitted`. Exit codes: `1` bad input, `2` not found,
`3` `az` missing, `4` `az`/`git` failed.
