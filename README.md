# dova

Azure DevOps from the terminal — work items, pull requests and pipelines for the repo you're in, the way `gh` does it for GitHub. Org, project and repo come from your git remote; there's nothing to configure.

```console
$ dova view 4821                      # read the ticket
$ git checkout -b fix/4821-login
$ dova link 4821                      # this branch is for #4821
  … work, commit …
$ dova pr create --title 'Fix login redirect' --body - < notes.md
$ dova status                         # PR, work items, CI, review threads
$ dova pr reply 612 3 'Fixed in 9f2c' --resolve
$ dova pipeline log                   # why CI failed
```

## Install

```sh
git clone <this repo> && cd dova && npm install && npm run build && npm link
```

Needs Node 20+, git, and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli). You sign in with `az login`, once — and if you haven't, the first `dova` command runs it for you.

## Commands

| | |
|---|---|
| `dova status` | the current branch: its PR, work items, latest runs, review threads |
| `dova summarize [branch\|pr]` | catch up: linked tickets, commits and diff since it diverged (`--files`, `--full`) |
| `dova view <id\|link>` | a work item or a PR |
| `dova link <ids…>` / `unlink` / `list` | record which work items a branch is for; `pr create` links them |
| `dova wi view\|search\|create` | work items; `create` finds the team's area and current sprint, then remembers them |
| `dova bug <title>` | `wi create --type Bug` (`--at file:line` adds a permalink, `--link` links it) |
| `dova pr create\|view` | open a PR from the branch (target and work items worked out), or read one with its threads |
| `dova pr comment\|thread\|reply\|resolve` | review threads |
| `dova pipeline list\|log\|watch` | runs for the branch, the failed task's log, follow a run |
| `dova api <path>` | any REST call, signed in |
| `dova auth status` · `dova daemon status\|stop` | who you're signed in as · the background process |
| `dova instructions [--repo]` | teach coding agents (Copilot, Windsurf/Devin, Cursor, Codex) to use dova |
| `dova completion <shell>` | bash, zsh, fish, powershell |

Every command takes `--json [fields]` and `--jq <expr>`, and `--org`/`--project`/`--repo` (or `$DOVA_ORG`/`$DOVA_PROJECT`) outside an Azure Repos clone. Free text can be piped in with `-`. Exit codes: `1` bad input, `2` not found, `3` not signed in or no access, `4` a request failed.

## How it works

The first command starts **dovad**, a background process that stays up. It asks `az` for an Azure DevOps token once, keeps it in memory, and makes every REST request for the CLI over a user-only socket — so a command costs its round trips, not a Python start per call. A new `az login` is picked up on its own, an organization in another tenant gets a token for that tenant, and a newer dova replaces an older daemon. `DOVA_NO_DAEMON=1` does it all in-process instead.

What dova remembers lives in git config: `branch.<name>.dova-workitems` for links, `dova.area`/`dova.iteration`/`dova.team` for where new work items go.

```
src/
  main.ts, app.ts       entry; the App every command gets (git, client, prompts, stdin, scope)
  cli/framework.ts      command definitions → commander, --json/--jq, output, exit codes
  cli/commands/         one file per area: logic plus rendering
  ado/                  client (typed REST calls), map (REST → types), auth (az token, session)
  daemon.ts             dovad: server, client, auto-start
  git.ts, core/         git and branch links; types, URL parsing, text helpers
```

`npm test` · `npm run typecheck` · `npm run build` · `npm run dev -- status`
