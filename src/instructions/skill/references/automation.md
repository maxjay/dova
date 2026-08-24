# Running dova without a human

## It never prompts

With no terminal on stdin, `dova` does not ask questions — it fails
immediately, naming the flag that would have answered it and listing
the real values:

```console
$ dova bug 'Something broke'
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.
  Available: Platform, Payments
  (dova is running without a terminal, so it cannot ask.)
```

Read the error and re-run with that flag. The error is the answer.

Escape hatches for team, area and iteration:

- `--team <name>` — resolve area and iteration from that team
- `--area <path>` and `--iteration <path>` — set both directly; together
  they skip team resolution entirely
- `--like <id>` — copy area and iteration from an existing ticket
- `--save` — with `--like`, persist them as this repo's default
- `--reresolve` — ignore what is cached and resolve again

`--no-input` or `DOVA_NO_INPUT=1` force this behaviour even in a
terminal.

Prompts that are conveniences rather than decisions take the safe
answer instead of failing: "save this to git config?" declines, and
"switch to the branch that already links this?" declines. `dova` will
not check out a branch you did not ask it to.

## Free text goes on stdin

The shell mangles text before `dova` ever sees it. In bash,
`"...$total..."` expands to nothing and backticks inside double quotes
are **executed**:

```console
✗ dova pr comment 612 "Fixed the $count check in `auth.ts`"
```

There is no recovery — the text is gone before the process starts.
Pipe it instead, and nothing needs escaping:

```console
$ dova pr comment 612 - <<'EOF'
Fixed the $count check in `auth.ts` — the "total" field was null.
EOF
```

The quoted heredoc delimiter (`<<'EOF'`, not `<<EOF`) is what disables
expansion. Every command taking free text accepts `-` for stdin;
`--title -` does the same for the flag form.

Short titles are fine inline if **single**-quoted — single quotes are
literal in bash, zsh and PowerShell alike. They cannot carry an
apostrophe, so pipe anything containing one.

`dova` normalizes what arrives: the trailing newline a heredoc adds,
CRLF line endings, and it errors on empty input rather than posting a
blank comment.

## Parsing output

`--json` on any read command; `--json <fields>` restricts to a
comma-separated list; `--jq <expr>` filters that JSON. Human output is
for humans and its shape is not a contract.

Decide before running. Running a command and then re-running it with
`--json` pays the whole cost twice, `az` process included, for output
already on screen.

```console
$ dova summarize --json branch,base,commits
$ dova status --json --jq '.pr.id'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | bad input — missing or contradictory flags |
| `2` | not found — no such PR, work item or team |
| `3` | prerequisite — `az` missing, not logged in, or the azure-devops extension absent |
| `4` | an underlying `az`/`git` call failed |
| `5` | unanticipated |

`2` is distinct from `1` on purpose: "no PR for this branch" is a
normal state to branch on, not a usage error.

## Speed

Every `az` invocation starts a Python interpreter — around 2-3 seconds
on Windows before any network. The number of *sequential* `az` calls
dominates runtime, not the size of the responses. Prefer one command
that returns everything (`dova status`, `dova summarize`) over several
that each return part of it.
