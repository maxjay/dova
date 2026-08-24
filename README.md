# dova

**Azure DevOps, from the terminal.** `dova` gives Azure Boards, Azure
Repos, and Azure Pipelines the command-line experience `gh` gives
GitHub and `glab` gives GitLab — work items, pull requests, and
pipeline runs, without leaving your shell, and without typing an
organization or project name into every command.

Under the hood there's no separate API client: every operation is a
`git` command or an `az` call (Azure CLI's `azure-devops` extension).
`dova` is the layer that knows which one to run, with which arguments,
from nothing but the repository you're already standing in.

## Features

- **Context-aware.** Organization, project, and repo come from your
  `git remote`. Team, area path, and iteration are asked once per repo
  and then remembered. No config file to hand-author, no `--org`/
  `--project` on every call.
- **A proxy, not a workflow engine.** `dova` never creates, names, or
  checks out a branch, and never touches a ticket's state or assignee.
  Those stay entirely yours — git and Azure Boards, used the way you
  already use them.
- **Linkage, tracked for you.** `dova link` records which branch
  corresponds to which work item; `dova pr create` reads it back out
  and attaches the ticket automatically. `dova list`/`dova summarize`
  make that history queryable later.
- **Goes where `az` doesn't.** Comment threads, work item type/state
  metadata, and pipeline run logs have no native `az` command at all —
  `dova` fills the gap with direct, authenticated REST calls.
- **Script-friendly.** `--json [fields]` and `--jq <expr>` on every read
  command, exit codes that distinguish "not found" from "bad input"
  from "az failed," shell completions for bash/zsh/fish/PowerShell.

## Install

```sh
git clone <this-repo> && cd dova
npm install && npm run build
npm link
```

**Requirements:** Node 20+, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
with the DevOps extension, and an existing session:

```sh
az extension add --name azure-devops
az login
```

`dova` reads your `az` credentials and configuration; it doesn't manage
its own.

## Usage

Read the ticket, then start work — `dova` records the link, git does
everything else:

```console
$ dova wi view 4821
#4821 Login redirects to the wrong page after sign-in
Bug · Active · assigned to Jane Doe

Area:      MyProject\Platform
Iteration: MyProject\Sprint 14

https://dev.azure.com/contoso/MyProject/_workitems?id=4821

$ git checkout -b fix/4821-login-redirect
$ dova link 4821
Branch: fix/4821-login-redirect

Linked work items:
  #4821 [Bug] Login redirects to the wrong page after sign-in (primary)
```

File what you find as you go, and it gets linked in the same call:

```console
$ dova bug "Null check missing on empty session token" --at src/auth.ts:88 --link
Created Bug #5219
  https://dev.azure.com/contoso/MyProject/_workitems?id=5219
  Project: MyProject
  Area: MyProject\Platform
  Iteration: MyProject\Sprint 14

Branch: fix/4821-login-redirect

Linked work items:
  #4821 [Bug] Login redirects to the wrong page after sign-in (primary)
  #5219 [Bug] Null check missing on empty session token
```

Open the PR — both tickets attach automatically, no flags needed:

```console
$ dova pr create --title "Fix null check in redirect handler"
Created PR #612 — Fix null check in redirect handler
  https://dev.azure.com/contoso/MyProject/_git/my-repo/pullrequest/612
  Work items: #4821, #5219
```

Check in on it later, one screen for the whole picture:

```console
$ dova status
Branch: fix/4821-login-redirect

Pull Request
  #612 Fix null check in redirect handler
  active · opened by Agent
  https://dev.azure.com/contoso/MyProject/_git/my-repo/pullrequest/612

Work Items
┌───────┬──────┬───────────────────────────────────────────────┬────────┐
│ ID    │ Type │ Title                                          │ State  │
├───────┼──────┼───────────────────────────────────────────────┼────────┤
│ #4821 │ Bug  │ Login redirects to the wrong page after sign-in│ Active │
├───────┼──────┼───────────────────────────────────────────────┼────────┤
│ #5219 │ Bug  │ Null check missing on empty session token      │ New    │
└───────┴──────┴───────────────────────────────────────────────┴────────┘

Pipeline Runs
┌──────────┬────────┬────────┬──────────────────────────────────────────┐
│ Pipeline │ Result │ Queued │ URL                                       │
├──────────┼────────┼────────┼──────────────────────────────────────────┤
│ CI       │ failed │ ?      │ .../_build/results?buildid=4102          │
└──────────┴────────┴────────┴──────────────────────────────────────────┘

Comment Threads
┌──────────┬─────────────────┬─────────────┬────────────────────────────────────┐
│ Status   │ Location        │ Last author │ Last comment                       │
├──────────┼─────────────────┼─────────────┼────────────────────────────────────┤
│ open     │ /src/auth.ts:42 │ Jane Doe    │ Can you also handle the null case..│
├──────────┼─────────────────┼─────────────┼────────────────────────────────────┤
│ resolved │ —               │ Bot         │ Nice catch                         │
└──────────┴─────────────────┴─────────────┴────────────────────────────────────┘
```

A thread anchored to a line of code (a quality-gate finding, say) carries
its file and line; a general comment doesn't. The table only ever shows
the *last* comment, though — to actually read the conversation before
acting on it:

```console
$ dova pr comment show 612 4
Thread #4 on PR #612
/src/auth.ts:42
Status: active

SonarQube · 2026-08-22T10:00:00Z
  Fix this cognitive complexity issue by extracting the validation logic.

Jane Doe · 2026-08-22T10:15:00Z
  Can you also handle the null case here while you're at it?
```

CI is red — find out why without opening a browser:

```console
$ dova pipeline log
Task: npm test
FAIL src/auth.test.ts
  ✕ redirects to /dashboard on valid token (14 ms)

  Expected: "/dashboard"
  Received: "/undefined"
```

Picking this branch back up next week, or handing it to someone else —
`list` finds it, `summarize` catches you up:

```console
$ dova list
┌─────────────────────────┬─────────┬───────────────────────────────────┬─────────┐
│ Branch                  │ Primary │ Title                              │         │
├─────────────────────────┼─────────┼───────────────────────────────────┼─────────┤
│ feature/305-dark-mode   │ #305    │ Add dark mode                      │         │
├─────────────────────────┼─────────┼───────────────────────────────────┼─────────┤
│ fix/4821-login-redirect │ #4821   │ Login redirects to the wrong page..│ +1 more │
└─────────────────────────┴─────────┴───────────────────────────────────┴─────────┘

$ dova summarize fix/4821-login-redirect
Branch: fix/4821-login-redirect
compared against main

#4821 [Bug/Active] Login redirects to the wrong page after sign-in (primary)
Root cause: session token isn't checked for null before the redirect decision is made.

#5219 [Bug/New] Null check missing on empty session token

Commits (2 since main)
  096de60 Add regression test for redirect
  2dbd4b9 Fix null check in redirect handler

Diff
src/auth.ts | 2 ++
 1 file changed, 2 insertions(+)
```

## Commands

| | |
|---|---|
| **Status & discovery** | |
| `dova status` | Active PR, linked work items, recent pipeline runs, comment threads — one screen. |
| `dova list` | Every branch with a linked ticket, most recently active first. |
| `dova summarize [branch\|id\|url]` | A catch-up report: linked tickets, commit log, diff stat since it diverged — for a branch or a PR. Default: current branch. Fetches first if it's not local. |
| `dova view <id\|url>` | Read a work item or PR from a bare id or a pasted link — detects which. |
| **Work items** | |
| `dova bug <title>` | File a Bug fast. `--at file:line` for a permalink, `--link` to link it in the same call. |
| `dova wi quick <type> <title>` | `bug`, generalized to any work item type. |
| `dova wi create` | The full create command — `--assign-to`, `--parent`. |
| `dova wi view <id\|url>` | A work item plus its parent and children. |
| `dova wi search` | Flag-driven search, built into a WIQL query. |
| **Pull requests** | |
| `dova pr create` | Open a PR; auto-attaches whatever `dova link` recorded. |
| `dova pr view [id\|url]` | A PR's detail, including comment threads. |
| `dova pr comment <id> <text>` | Post a new comment thread. Omit `<text>` or pass `-` to read it from stdin. |
| `dova pr comment show <id> <thread-id>` | Read a thread's full conversation — every comment, not just the last one. |
| `dova pr comment reply <id> <thread-id> <text>` | Reply within an existing thread. `--resolve [status]` also resolves it in the same call; `-` reads the reply from stdin. |
| `dova pr comment resolve <id> <thread-id> [status]` | Change a thread's status (`resolved` by default). |
| **Pipelines** | |
| `dova pipeline status` | Recent runs for a branch. |
| `dova pipeline watch [run-id]` | Poll a run until it finishes; exits non-zero on failure. |
| `dova pipeline log [run-id]` | The failing task's own log — not just "it failed." |
| **Linking** | |
| `dova link <id...>` | Associate the current branch with one or more work items. |
| `dova unlink [id...]` | Undo it — remove id(s) from the current branch (`--all` for everything). |
| **Agent setup** | |
| `dova instructions init` | Teach Devin Desktop/Copilot to use dova — writes `AGENTS.md` and `.github/copilot-instructions.md`. |
| **Everything else** | |
| `dova api <path>` | An authenticated REST call, for anything not wrapped above. |
| `dova completion <shell>` | Shell completions, generated from the live command tree. |

Every read command accepts `--json [fields]` and `--jq <expr>`; most
accept `--web` to open the browser instead. `--no-color`/`$NO_COLOR`
are respected everywhere, and `--no-color`'s sibling `--no-input` is
covered under [Running without a terminal](#running-without-a-terminal).

## Running without a terminal

Agents, CI jobs, and anything on the end of a pipe have no one to answer
a question. dova never prompts in that situation — it fails immediately
instead, naming the flag that would have answered it and listing the
real values to choose from:

```console
$ dova bug 'Null check missing'
Error: Multiple teams in "MyProject" — which one?
  Pass --team <name>.
  Available: Platform, Payments
  (dova is running without a terminal, so it cannot ask.)
```

An error costs milliseconds; a prompt nobody can answer hangs until
something times out. `--team`, `--area`, `--iteration`, and `--like
<id>` are the escape hatches, and `--area`/`--iteration` together skip
team resolution altogether. Prompts that are *conveniences* rather than
decisions — "save this to git config?", "switch to the branch that
already links this?" — quietly take the safe answer instead of erroring,
so nothing is written or checked out that wasn't asked for.

This is detected from `stdin` not being a TTY; `--no-input` or
`DOVA_NO_INPUT=1` force it on regardless.

**Free text goes on stdin.** Anything typed on a command line is parsed
by the shell before dova ever sees it — in bash `"...$total..."`
expands to nothing and ``"...`npm test`..."`` *runs npm test*. dova
can't recover text that was destroyed before it started, so anything
containing backticks, `$`, or quotes should be piped in:

```console
$ dova pr comment 612 - <<'EOF'
Use `npm test` to verify — the "total" field is $null.
EOF
Posted comment on PR #612 (thread #14).
```

Nothing in there is escaped, by you or by dova's caller. Short titles
are fine inline as long as they're **single**-quoted (literal in bash,
zsh and PowerShell alike); reach for stdin when the text contains an
apostrophe or runs long. Every command taking free text accepts `-`,
and `--title -` does the same for the flag form.

## Teaching a coding agent to use it

`dova` is already usable by anything that can run a shell command. What
an agent can't get from `--help` is the ordering that matters (`dova
link` before `dova pr create`, or the PR opens with no ticket attached
and no error), the boundaries it shouldn't route around with raw `az`,
and the stdin rule above. `dova instructions init` writes that down:

```console
$ dova instructions init
Wrote:
  ✓ AGENTS.md  — Devin Desktop / Windsurf (also Cursor, Codex)
      created
  ✓ .github/copilot-instructions.md  — GitHub Copilot in VS Code
      created
```

Two files rather than one because neither target reads the other's by
default. Devin Desktop — what Windsurf was renamed to in June 2026,
after which its Cascade agent was retired in favour of Devin Local —
reads a root `AGENTS.md` as an always-on rule, feeding it into the same
rules engine behind `.devin/rules/`, so there's no need to write that
directory too. VS Code's `AGENTS.md` support, by contrast, is
experimental and off behind `chat.useAgentsMdFile`; there,
`.github/copilot-instructions.md` is what works out of the box. Same
content in both, generated from one source rather than maintained
twice, and not a symlink because a Windows checkout with
`core.symlinks=false` turns one into a text file containing a path,
silently.

It's `instructions`, not `agents`, because that's what these files are —
VS Code and GitHub both call them "custom instructions". An *agent*
(`.agent.md`, `.github/agents/`) is a different thing: a persona with its
own role, tools, and model, which this doesn't write. `dova agents init`
still works as an alias, since `AGENTS.md` is the name people know.

Content goes inside a `<!-- dova:start -->` / `<!-- dova:end -->` block,
so re-running updates it in place and never disturbs anything else in
those files. `--dry-run` shows what would change. If a
`.vscode/settings.json` in the repo has switched Copilot's instruction
files off, it says so — otherwise everything would be written correctly
and silently ignored.

## How it resolves context

**Org, project, repo** come from `git remote get-url origin`, parsed
for both `dev.azure.com/{org}/{project}/_git/{repo}` and its SSH
equivalent. `--org`, `--project`, and `--repo` override any of it.

**Team, area, iteration** matter only when *filing* a new work item.
The first time a repo needs one, `dova` asks; after that it's
remembered in that repo's own git config (`dova.team`, `dova.area`,
`dova.iteration`) — no server-side state, no separate cache. `--like
<id>` copies an existing ticket's area/iteration directly instead, for
the rare case where a ticket belongs to a different team than the
repo's usual one; `--team <name>` does the same by team name.

**Branch ↔ ticket linkage** is the one thing `dova` persists that
neither git nor Azure DevOps tracks on its own — written by `dova
link`, read back by `dova pr create`, and surfaced later by `dova
list`/`dova summarize`. It lives in that branch's own git config, so it
never needs a server round-trip and travels with the branch. `dova
unlink` undoes it.

**Reading a diff** works the same way `az repos pr checkout` does under
the hood (confirmed from source: a plain fetch of the PR's own branch
name, no special merge ref). `az` itself has no diff command at all.
`dova summarize` resolves the branch involved to a usable ref — local
if it's already there, the existing remote-tracking ref if it's
already been fetched, or one fresh `git fetch origin <branch>` if
neither — then diffs locally. Nothing is checked out, so pointing
`dova summarize` at a PR id or url works for one you never touched as
readily as your own.

## Contributing

```sh
npm run dev -- status   # run from source via tsx, no build step
npm test                 # vitest
npm run typecheck         # tsc --noEmit
npm run build              # bundle to dist/index.js
```

```
src/
  cli.ts / index.ts     command tree + entrypoint
  commands/              one file per command
  lib/
    exec.ts              the only place that shells out to az/git — every command takes a Runner, so tests fake it
    context.ts            org/project/repo/branch resolution
    team-resolver.ts      team/area/iteration resolution
    link.ts / work-items.ts / pr.ts / pipelines.ts / wiql.ts / urls.ts
                            fetch/render logic per Azure DevOps entity, shared across commands
  types/azure-devops.ts  minimal REST object shapes
tests/                    one *.test.ts per lib module — no real az/git process ever runs
```

**No organization-specific value is hardcoded anywhere** — not in
source, not in examples, not in tests. Fixtures throughout use
`contoso`/`MyProject`/`my-repo` as placeholders.

**When `az` doesn't have a command for something**, the fix is direct
`az rest` calls against the REST API, not a workaround. Before assuming
a shape or writing a fallback for an edge case, check the
[`azure-devops-cli-extension`](https://github.com/Azure/azure-devops-cli-extension)
source — its `commands.py` per command group is the ground truth for
what's actually registered, more reliable than `--help` or the docs
site for anything obscure.

## License

MIT
