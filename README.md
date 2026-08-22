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
┌──────────┬─────────────┬──────────────────────────────────────────────┐
│ Status   │ Last author │ Last comment                                 │
├──────────┼─────────────┼──────────────────────────────────────────────┤
│ open     │ Jane Doe    │ Can you add a test for the empty-string case?│
├──────────┼─────────────┼──────────────────────────────────────────────┤
│ resolved │ Jane Doe    │ Looks good now                               │
├──────────┼─────────────┼──────────────────────────────────────────────┤
│ resolved │ Bot         │ Nice catch                                   │
└──────────┴─────────────┴──────────────────────────────────────────────┘
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
| `dova summarize <branch>` | A catch-up report: linked tickets, commit log, diff stat since it diverged. |
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
| `dova pr comment <id> <text>` | Post a new comment thread. |
| `dova pr comment reply <id> <thread-id> <text>` | Reply within an existing thread. |
| `dova pr comment resolve <id> <thread-id> [status]` | Change a thread's status (`resolved` by default). |
| **Pipelines** | |
| `dova pipeline status` | Recent runs for a branch. |
| `dova pipeline watch [run-id]` | Poll a run until it finishes; exits non-zero on failure. |
| `dova pipeline log [run-id]` | The failing task's own log — not just "it failed." |
| **Linking** | |
| `dova link <id...>` | Associate the current branch with one or more work items. |
| **Everything else** | |
| `dova api <path>` | An authenticated REST call, for anything not wrapped above. |
| `dova completion <shell>` | Shell completions, generated from the live command tree. |

Every read command accepts `--json [fields]` and `--jq <expr>`; most
accept `--web` to open the browser instead. `--no-color`/`$NO_COLOR`
are respected everywhere.

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
never needs a server round-trip and travels with the branch.

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
